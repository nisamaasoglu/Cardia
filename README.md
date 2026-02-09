# 💓 Arduino Real-Time Pulse Monitor

An IoT-based health monitoring system that captures real-time heart rate data using an **Arduino** and visualizes it on a dynamic **Web Interface**.

## 🎯 Project Overview
This project bridges the gap between hardware sensors and web visualization. It reads raw data from a pulse sensor connected to an Arduino board and transmits it to a web-based dashboard for instant monitoring.

## 🛠️ Tech Stack & Hardware
- **Hardware:** Arduino Uno (or compatible), Pulse Sensor
- **Software:** Arduino IDE (C++), HTML5, JavaScript (for data visualization)
- **Communication:** Serial Data Transmission

## ⚙️ How It Works
1.  **Data Acquisition:** The Pulse Sensor detects the heartbeat from the fingertip.
2.  **Processing:** Arduino (`pulse_sensor.ino`) processes the analog signal.
3.  **Visualization:** The web interface (`index.html`) reads the data stream and plots a real-time graph, accompanied by visual and audio feedback.

## 📂 File Structure
- `pulse_sensor.ino`: The main Arduino sketch code.
- `index.html`: The frontend dashboard for monitoring.
- `assets/`: Contains images and sound files used in the interface.

---
*Developed by Nisa Maasoğlu*
