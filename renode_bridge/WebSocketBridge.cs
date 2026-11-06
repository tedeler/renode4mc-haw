using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals;
using Antmicro.Renode.Peripherals.Bus;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class WebSocketBridge : IDoubleWordPeripheral, IGPIOReceiver, INumberedGPIOOutput, IDisposable
    {
        public WebSocketBridge(IMachine machine, int port = 9000)
        {
            this.port = port;
            var innerConnections = new Dictionary<int, IGPIO>();
            for(int i = 0; i < 32; i++)
            {
                innerConnections[i] = new GPIO();
            }
            Connections = innerConnections;

            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "WSBridgeAccept" };
            acceptThread.Start();
            this.Log(LogLevel.Info, "WebSocketBridge lauscht auf ws://127.0.0.1:{0}", port);
        }

        public void Reset()
        {
            angle = 0;
            foreach(var conn in Connections.Values) conn.Unset();
        }

        // 1. Vom uC -> Web-GUI (via GPIO Pin-Änderung, z.B. LED oder Step-Pin)
        public void OnGPIO(int number, bool value)
        {
            // Beispiel: Pin 0 = LED, Pin 1 = Schrittmotor-Takt (bei steigender Flanke +15 Grad)
            if(number == 1 && value)
            {
                angle = (angle + 15) % 360;
                SendJson(string.Format("{{\"type\":\"angle\",\"value\":{0}}}", angle));
            }
            SendJson(string.Format("{{\"type\":\"gpio\",\"pin\":{0},\"state\":{1}}}", number, value ? "true" : "false"));
        }

        // 2. Vom uC -> Web-GUI (via Memory-Mapped Register an Offset 0x00)
        public uint ReadDoubleWord(long offset)
        {
            return (uint)angle;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            if(offset == 0x00) // Offset 0x00 setzt direkt den Drehwinkel (0..360)
            {
                angle = (int)(value % 360);
                SendJson(string.Format("{{\"type\":\"angle\",\"value\":{0}}}", angle));
            }
        }

        public IReadOnlyDictionary<int, IGPIO> Connections { get; private set; }

        private void AcceptLoop()
        {
            while(running)
            {
                try
                {
                    var tcpClient = listener.AcceptTcpClient();
                    var netStream = tcpClient.GetStream();
                    if(PerformHandshake(netStream))
                    {
                        lock(sync) { stream = netStream; }
                        this.Log(LogLevel.Info, "Web-UI verbunden.");
                        SendJson(string.Format("{{\"type\":\"angle\",\"value\":{0}}}", angle));
                        ReceiveLoop(netStream);
                    }
                }
                catch(Exception) { if(!running) break; }
            }
        }

        private bool PerformHandshake(NetworkStream netStream)
        {
            byte[] buffer = new byte[2048];
            int bytesRead = netStream.Read(buffer, 0, buffer.Length);
            string request = Encoding.UTF8.GetString(buffer, 0, bytesRead);
            if(!request.Contains("Upgrade: websocket")) return false;

            string key = "";
            foreach(var line in request.Split(new[] { "\r\n" }, StringSplitOptions.None))
            {
                if(line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                    key = line.Split(':')[1].Trim();
            }

            string acceptKey = Convert.ToBase64String(
                SHA1.Create().ComputeHash(Encoding.UTF8.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
            );

            string response = "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n";
            byte[] respBytes = Encoding.UTF8.GetBytes(response);
            netStream.Write(respBytes, 0, respBytes.Length);
            return true;
        }

        // 3. Von Web-GUI -> uC (Taster / Sensoren schalten GPIO-Interrupts in Renode)
        private void ReceiveLoop(NetworkStream netStream)
        {
            byte[] header = new byte[2];
            while(running && netStream.CanRead)
            {
                if(netStream.Read(header, 0, 2) < 2) break;
                int opcode = header[0] & 0x0F;
                if(opcode == 8) break; // Close Frame

                bool masked = (header[1] & 0x80) != 0;
                int payloadLen = header[1] & 0x7F;
                if(payloadLen > 125) break; // Für kurze Steuernachrichten reichen <125 Bytes

                byte[] mask = new byte[4];
                if(masked) netStream.Read(mask, 0, 4);

                byte[] payload = new byte[payloadLen];
                netStream.Read(payload, 0, payloadLen);
                if(masked)
                {
                    for(int i = 0; i < payloadLen; i++) payload[i] ^= mask[i % 4];
                }

                string msg = Encoding.UTF8.GetString(payload);
                // Simpler Befehl aus dem Browser: "PIN:0:1" setzt Ausgang 0 der Bridge auf High
                if(msg.StartsWith("PIN:"))
                {
                    var parts = msg.Split(':');
                    int pin = int.Parse(parts[1]);
                    bool state = parts[2] == "1";
                    if(Connections.ContainsKey(pin))
                    {
                        Connections[pin].Set(state);
                        this.Log(LogLevel.Debug, "Web-Input setzt GPIO {0} auf {1}", pin, state);
                    }
                }
            }
        }

        private void SendJson(string json)
        {
            lock(sync)
            {
                if(stream == null || !stream.CanWrite) return;
                try
                {
                    byte[] payload = Encoding.UTF8.GetBytes(json);
                    List<byte> frame = new List<byte> { 0x81 }; // FIN + Text-Frame
                    if(payload.Length <= 125)
                    {
                        frame.Add((byte)payload.Length);
                    }
                    else
                    {
                        frame.Add(126);
                        frame.Add((byte)((payload.Length >> 8) & 0xFF));
                        frame.Add((byte)(payload.Length & 0xFF));
                    }
                    frame.AddRange(payload);
                    stream.Write(frame.ToArray(), 0, frame.Count);
                }
                catch { stream = null; }
            }
        }

        public void Dispose()
        {
            running = false;
            listener?.Stop();
        }

        private readonly int port;
        private readonly TcpListener listener;
        private readonly Thread acceptThread;
        private readonly object sync = new object();
        private NetworkStream stream;
        private volatile bool running = true;
        private int angle;
    }
}
