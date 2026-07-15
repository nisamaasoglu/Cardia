/*
 * Cardia - Arduino firmware
 * -----------------------------------------------------------------------------
 * Reads a single-lead ECG from an AD8232 breakout on A0, detects R-peaks with an
 * adaptive-threshold detector, and serves the heart rate as JSON over HTTP using
 * an Ethernet shield.
 *
 * Endpoint:  GET http://<device-ip>/   ->  application/json
 *
 * Response shape:
 * {
 *   "raw": 512,          // latest ADC sample (0-1023)
 *   "bpm": 74,           // beats per minute, 0 while unknown
 *   "ibi": 810,          // last R-R interval in ms, 0 while unknown
 *   "amplitude": 180,    // peak-to-peak amplitude of the current window
 *   "quality": 1,        // 1 = electrodes attached and signal usable, 0 = not
 *   "beats": 42,         // R-peaks detected since boot (lets the client trigger
 *                        //   animation/sound on real detections, not on a timer)
 *   "uptime": 61234,     // ms since boot
 *   "wave": [...]        // 96 decimated samples, oldest -> newest
 * }
 *
 * Hardware
 *   Arduino Uno (or compatible) + Ethernet shield (W5100)
 *   AD8232 single-lead ECG breakout:
 *     OUTPUT -> A0,  3.3V -> 3.3V,  GND -> GND
 *   Three electrode pads on the body (RA / LA / RL).
 *
 *   Optional leads-off detection (see USE_LEADS_OFF below):
 *     LO+ -> D10,  LO- -> D11
 *   Leave it disabled if those two wires are not connected - floating digital
 *   pins read noise and would report "electrodes off" at random.
 *
 * Author: Nisa Maasoglu
 * License: MIT
 */

#include <SPI.h>
#include <Ethernet.h>

// ---------------------------------------------------------------- configuration
byte mac[] = { 0x90, 0xA2, 0xDA, 0x00, 0x7F, 0x01 };
IPAddress ip(192, 168, 1, 177);          // must match the address used in the web client
EthernetServer server(80);

const int SENSOR_PIN = A0;               // AD8232 OUTPUT

#define USE_LEADS_OFF 0                  // set to 1 only if LO+/LO- are wired up
#if USE_LEADS_OFF
  const int LO_PLUS_PIN  = 10;
  const int LO_MINUS_PIN = 11;
#endif

const unsigned long SAMPLE_INTERVAL_US = 2000UL;  // 2 ms -> 500 Hz sampling

// R-peak detection
const int   MIN_AMPLITUDE     = 60;    // peak-to-peak below this = electrodes off / flat
const float THRESHOLD_RATIO   = 0.65;  // R-peak is sharp; fire high in the dynamic range
const float RELEASE_RATIO     = 0.45;  // hysteresis level
const unsigned long REFRACTORY_MS = 250;  // physiological blanking after an R-peak
const unsigned long MIN_IBI   = 300;   // ms  -> rejects anything above 200 BPM
const unsigned long MAX_IBI   = 2000;  // ms  -> rejects anything below  30 BPM
const unsigned long ENVELOPE_DECAY_MS = 2000; // how fast the min/max envelope relaxes
const unsigned long SIGNAL_TIMEOUT_MS = 3000; // no R-peak for this long -> BPM unknown

// Waveform buffer sent to the client.
// 125 Hz keeps the QRS complex (~80 ms wide) visible; 62.5 Hz would flatten it.
const int WAVE_SIZE  = 96;
const int DECIMATION = 4;              // every 4th sample of 500 Hz -> 125 Hz, ~0.77 s

// ---------------------------------------------------------------- runtime state
int  wave[WAVE_SIZE];
int  waveHead = 0;
int  decimateCount = 0;

int  signalMin = 1023;
int  signalMax = 0;
int  lastRaw = 0;
int  amplitude = 0;
bool above = false;                    // hysteresis latch for the threshold crossing

unsigned long lastSampleUs = 0;
unsigned long lastBeatMs = 0;
unsigned long lastEnvelopeResetMs = 0;
unsigned long ibi = 0;
unsigned long beatCount = 0;
bool leadsOff = false;

// Moving average over the last R-R intervals -> smooths the reported BPM
const int IBI_HISTORY = 5;
unsigned long ibiHistory[IBI_HISTORY];
int ibiIndex = 0;
int ibiFilled = 0;
int bpm = 0;

// ---------------------------------------------------------------- setup
void setup() {
  Serial.begin(9600);

  for (int i = 0; i < WAVE_SIZE; i++) wave[i] = 0;

#if USE_LEADS_OFF
  pinMode(LO_PLUS_PIN, INPUT);
  pinMode(LO_MINUS_PIN, INPUT);
#endif

  Ethernet.begin(mac, ip);

  if (Ethernet.hardwareStatus() == EthernetNoHardware) {
    Serial.println(F("Ethernet shield not found - halting."));
    while (true) { delay(1); }
  }
  if (Ethernet.linkStatus() == LinkOFF) {
    Serial.println(F("Ethernet cable is not connected."));
  }

  server.begin();
  Serial.print(F("Cardia server at http://"));
  Serial.println(Ethernet.localIP());
}

// ---------------------------------------------------------------- signal path
void resetEnvelope(int current) {
  // Relax the envelope towards the current sample instead of hard-resetting it,
  // so one motion artefact cannot leave the threshold stuck out of reach.
  signalMax = current + (signalMax - current) / 2;
  signalMin = current - (current - signalMin) / 2;
  if (signalMax <= signalMin) { signalMax = current + 1; signalMin = current - 1; }
}

void updateBpm(unsigned long interval) {
  ibiHistory[ibiIndex] = interval;
  ibiIndex = (ibiIndex + 1) % IBI_HISTORY;
  if (ibiFilled < IBI_HISTORY) ibiFilled++;

  unsigned long sum = 0;
  for (int i = 0; i < ibiFilled; i++) sum += ibiHistory[i];
  bpm = (int)(60000UL / (sum / ibiFilled));
}

void clearBpm() {
  bpm = 0;
  ibi = 0;
  ibiFilled = 0;
  ibiIndex = 0;
}

void sampleSensor() {
  unsigned long nowUs = micros();
  if (nowUs - lastSampleUs < SAMPLE_INTERVAL_US) return;
  lastSampleUs = nowUs;

  unsigned long nowMs = millis();
  int raw = analogRead(SENSOR_PIN);
  lastRaw = raw;

#if USE_LEADS_OFF
  // The AD8232 pulls LO+ / LO- high when an electrode loses contact.
  leadsOff = (digitalRead(LO_PLUS_PIN) == HIGH) || (digitalRead(LO_MINUS_PIN) == HIGH);
#endif

  // --- rolling min/max envelope -> adaptive threshold ------------------------
  if (raw > signalMax) signalMax = raw;
  if (raw < signalMin) signalMin = raw;
  if (nowMs - lastEnvelopeResetMs > ENVELOPE_DECAY_MS) {
    resetEnvelope(raw);
    lastEnvelopeResetMs = nowMs;
  }
  amplitude = signalMax - signalMin;

  // --- store decimated waveform for the client chart ------------------------
  if (++decimateCount >= DECIMATION) {
    decimateCount = 0;
    wave[waveHead] = raw;
    waveHead = (waveHead + 1) % WAVE_SIZE;
  }

  // --- R-peak detection -----------------------------------------------------
  if (leadsOff || amplitude < MIN_AMPLITUDE) {
    above = false;
    if (nowMs - lastBeatMs > SIGNAL_TIMEOUT_MS) clearBpm();
    return;
  }

  int threshold = signalMin + (int)(amplitude * THRESHOLD_RATIO);
  int release   = signalMin + (int)(amplitude * RELEASE_RATIO);

  bool refractory = (nowMs - lastBeatMs) < REFRACTORY_MS;

  if (!above && !refractory && raw > threshold) {
    above = true;
    unsigned long interval = nowMs - lastBeatMs;
    if (lastBeatMs > 0 && interval >= MIN_IBI && interval <= MAX_IBI) {
      ibi = interval;
      updateBpm(interval);
      beatCount++;
    } else if (lastBeatMs == 0) {
      beatCount++;                       // first R-peak: start the clock only
    }
    lastBeatMs = nowMs;
  } else if (above && raw < release) {
    above = false;
  }

  if (lastBeatMs > 0 && nowMs - lastBeatMs > SIGNAL_TIMEOUT_MS) clearBpm();
}

// ---------------------------------------------------------------- HTTP layer
void sendJson(EthernetClient &client) {
  client.println(F("HTTP/1.1 200 OK"));
  client.println(F("Content-Type: application/json"));
  client.println(F("Access-Control-Allow-Origin: *"));
  client.println(F("Cache-Control: no-store"));
  client.println(F("Connection: close"));
  client.println();

  bool usable = !leadsOff && amplitude >= MIN_AMPLITUDE;

  // Printed in chunks - building one String would fragment the Uno's 2 KB SRAM.
  client.print(F("{\"raw\":"));       client.print(lastRaw);
  client.print(F(",\"bpm\":"));       client.print(bpm);
  client.print(F(",\"ibi\":"));       client.print(ibi);
  client.print(F(",\"amplitude\":")); client.print(amplitude);
  client.print(F(",\"quality\":"));   client.print(usable ? 1 : 0);
  client.print(F(",\"beats\":"));     client.print(beatCount);
  client.print(F(",\"uptime\":"));    client.print(millis());
  client.print(F(",\"wave\":["));
  for (int i = 0; i < WAVE_SIZE; i++) {
    if (i) client.print(',');
    client.print(wave[(waveHead + i) % WAVE_SIZE]);   // oldest -> newest
  }
  client.print(F("]}"));
}

void handleClient() {
  EthernetClient client = server.available();
  if (!client) return;

  // Drain the request headers so the browser does not see a connection reset.
  bool currentLineIsBlank = true;
  unsigned long start = millis();
  while (client.connected() && millis() - start < 200) {
    if (!client.available()) { sampleSensor(); continue; }
    char c = client.read();
    if (c == '\n' && currentLineIsBlank) break;
    if (c == '\n')      currentLineIsBlank = true;
    else if (c != '\r') currentLineIsBlank = false;
    sampleSensor();                     // keep sampling while parsing
  }

  sendJson(client);
  delay(1);                             // let the shield flush its TX buffer
  client.stop();
}

// ---------------------------------------------------------------- main loop
void loop() {
  sampleSensor();     // runs on every pass - no blocking delay() in the loop
  handleClient();
}
