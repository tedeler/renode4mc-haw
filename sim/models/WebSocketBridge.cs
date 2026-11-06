// Minimaler WebSocket-Server (Port 9000) für die HTML-LED-Anzeige.
//
// Das Modul hat 8 GPIO-Eingänge (0..7). Jede Pegeländerung wird als Text "LED<n>=<0|1>"
// an alle verbundenen Browser gesendet; neue Clients erhalten sofort den aktuellen Zustand.
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class WebSocketBridge : IGPIOReceiver
    {
        public WebSocketBridge(IMachine machine, int port = 9000)
        {
            clients = new List<NetworkStream>();
            state = new bool[8];
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            this.Log(LogLevel.Info, "WebSocket-Bridge lauscht auf ws://127.0.0.1:{0}", port);
            var t = new Thread(AcceptLoop) { IsBackground = true };
            t.Start();
        }

        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number > 7) return;
            lock(clients)
            {
                state[number] = value;
                Broadcast(Message(number));
            }
        }

        public void Reset()
        {
            lock(clients) { state = new bool[8]; }
        }

        private string Message(int i)
        {
            return "LED" + i + "=" + (state[i] ? "1" : "0");
        }

        private void Broadcast(string text)
        {
            var frame = Frame(text);
            foreach(var c in clients.ToArray())
            {
                try { c.Write(frame, 0, frame.Length); }
                catch { clients.Remove(c); }
            }
        }

        private static byte[] Frame(string text)
        {
            var payload = Encoding.UTF8.GetBytes(text);
            var f = new byte[2 + payload.Length];
            f[0] = 0x81;
            f[1] = (byte)payload.Length; // Nachrichten sind kurz (< 126 Byte)
            Array.Copy(payload, 0, f, 2, payload.Length);
            return f;
        }

        private void AcceptLoop()
        {
            while(true)
            {
                try
                {
                    var client = listener.AcceptTcpClient();
                    var thread = new Thread(() => Handshake(client)) { IsBackground = true };
                    thread.Start();
                }
                catch { return; }
            }
        }

        private void Handshake(TcpClient client)
        {
            try
            {
                var stream = client.GetStream();
                var buf = new byte[4096];
                int n = stream.Read(buf, 0, buf.Length);
                var request = Encoding.UTF8.GetString(buf, 0, n);
                int k = request.IndexOf("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase);
                if(k < 0) { client.Close(); return; }
                var key = request.Substring(k + 18, request.IndexOf("\r\n", k) - k - 18).Trim();
                var accept = Convert.ToBase64String(SHA1.Create().ComputeHash(
                    Encoding.UTF8.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                var response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
                               "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
                var bytes = Encoding.ASCII.GetBytes(response);
                stream.Write(bytes, 0, bytes.Length);
                lock(clients)
                {
                    clients.Add(stream);
                    keepAlive.Add(client); // sonst schließt der Garbage-Collector die Verbindung
                    for(int i = 0; i < 8; i++)
                    {
                        var f = Frame(Message(i));
                        stream.Write(f, 0, f.Length);
                    }
                }
            }
            catch { }
        }

        private readonly TcpListener listener;
        private readonly List<NetworkStream> clients;
        private readonly List<TcpClient> keepAlive = new List<TcpClient>();
        private bool[] state;
    }
}
