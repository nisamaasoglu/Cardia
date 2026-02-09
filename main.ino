#include <SPI.h>
#include <Ethernet.h>

byte mac[] = { 0x90, 0xA2, 0xDA, 0x00, 0x7F, 0x01 };
IPAddress ip(192, 168, 1, 177);

EthernetServer server(80);
const int nabizSensorPin = A0;

void setup() {
  Serial.begin(9600);
  while (!Serial) {
    ; // wait for serial port to connect
  }

  Serial.println("Ethernet WebServer Example");

  Ethernet.begin(mac, ip);

  if (Ethernet.hardwareStatus() == EthernetNoHardware) {
    Serial.println("Ethernet shield was not found. Sorry, can't run without hardware. :(");
    while (true) {
      delay(1);
    }
  }
  
  if (Ethernet.linkStatus() == LinkOFF) {
    Serial.println("Ethernet cable is not connected.");
  }

  server.begin();
  Serial.print("server is at ");
  Serial.println(Ethernet.localIP());
}

void loop() {
  // listen for incoming clients
  EthernetClient client = server.available();
  if (client) {
    Serial.println("new client");
    // an http request ends with a blank line
    boolean currentLineIsBlank = true;

    // Send HTTP headers manually
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: application/json");
    client.println("Connection: close");
    client.println("Access-Control-Allow-Origin: *");
    client.println("Access-Control-Allow-Methods: GET");
    client.println("Access-Control-Allow-Headers: Content-Type");
    client.println();

    // Anlık nabız değeri sensörden alınıyor
    int anlikNabiz = analogRead(nabizSensorPin);

    // JSON verisi oluşturuluyor
    String jsonVerisi = "{\"nabiz\":" + String(anlikNabiz) + "}";
    
    // JSON verisini client'a gönder
    client.print(jsonVerisi);

    // client'ı kapat
    delay(1);
    client.stop();
    Serial.println("client disconnected");

    // Bekleme süresi ekleyebilirsiniz
    delay(1000); // Örneğin, her 5 saniyede bir veri göndermek için
  }
}
