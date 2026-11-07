// CCS-Konsole im Simulator: C-Ein-/Ausgabe (printf, puts, putchar, ...) des TI-Laufzeitsystems.
//
// Auf dem Board landet printf() in der Konsole von Code Composer Studio. Das TI-Laufzeitsystem
// (TI Arm Clang und armcl) schreibt dazu eine Nachricht in den Puffer _CIOBUF_ und läuft über die
// Marke C$$IO$$. Dort hält der Debugger an, liest die Nachricht, gibt den Text aus und schreibt
// die Antwort zurück (Protokoll "CIO", trgmsg.c des TI-Laufzeitsystems):
//   Anfrage  _CIOBUF_:  Länge (4 Byte LE) | Befehl (1 Byte) | Parameter (8 Byte) | Daten
//   Antwort  _CIOBUF_:  Länge (4 Byte LE) | Parameter (8 Byte) | Daten
// Dieses Modell übernimmt die Rolle des Debuggers: ein Renode-Hook auf C$$IO$$ bearbeitet die
// Nachricht. Unterstützt: write (stdout/stderr -> Ausgabe), open/close (Scheindatei), read
// (liefert immer 0 Bytes = Dateiende, d. h. scanf liest nichts), lseek, getenv, time, clock.
//
// Programme ohne printf haben kein C$$IO$$ – dann tut das Modell nichts.
// Das Modell hängt sich nach jedem Laden einer Firmware (Symbole) neu ein.
//
// In der Plattform:   cio: Miscellaneous.TiCioConsole @ sysbus <0xF0000000, +0x100>
// (die Adresse ist nur ein Platzhalter für den Renode-Pfad, die Firmware greift nie darauf zu)
//
// Bedienung im Renode-Monitor:
//   sysbus.cio GetOutput     -> "CIO:<Base64>" mit allem, was seit dem letzten Aufruf ausgegeben wurde
//   sysbus.cio Text          -> die letzten (höchstens 16 KB) Ausgaben als Text
//   sysbus.cio Attached      -> True, wenn die Firmware CIO benutzt (C$$IO$$ gefunden)
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.CPU;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class TiCioConsole : IDoubleWordPeripheral, IKnownSize
    {
        public TiCioConsole(IMachine machine)
        {
            this.machine = machine;
            machine.SystemBus.OnSymbolsChanged += _ => Attach();
            Attach();
        }

        public long Size { get { return 0x100; } }

        public bool Attached { get { lock(sync) { return hookAddress.HasValue; } } }

        // Pfad der Firmware. Renode löscht beim Laden der Symbole Bit 0 jeder Adresse (Thumb) – das
        // Feld _CIOBUF_ darf aber auf einer ungeraden Adresse liegen. Deshalb liest das Modell die
        // Adresse direkt aus der Symboltabelle der ELF-Datei.   Im .resc:  sysbus.cio ElfPath $elf
        public string ElfPath
        {
            get { return elfPath; }
            set { elfPath = value; Attach(); }
        }

        public uint ReadDoubleWord(long offset)
        {
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
        }

        public void Reset()
        {
            lock(sync)
            {
                pending.Clear();
                history.Clear();
                nextFd = 3;
            }
        }

        public string GetOutput()
        {
            lock(sync)
            {
                var s = "CIO:" + Convert.ToBase64String(pending.ToArray());
                pending.Clear();
                return s;
            }
        }

        public string Text
        {
            get { lock(sync) { return Encoding.UTF8.GetString(history.ToArray()); } }
        }

        // Sucht C$$IO$$ und _CIOBUF_ in den geladenen Symbolen und setzt den Hook
        public void Attach()
        {
            var bus = machine.SystemBus;
            var cpu = bus.GetCPUs().OfType<ICPUWithHooks>().FirstOrDefault();
            if(cpu == null) return;

            ulong? hook = Find(bus, "C$$IO$$", true);
            ulong? buffer = null;
            var names = new[] { "_CIOBUF_", "__CIOBUF_", "__CIOBUF__", "CIOBUF" };
            var fromElf = ElfSymbols(names);
            foreach(var name in names)
            {
                ulong a;
                if(fromElf.TryGetValue(name, out a)) buffer = a;
                else buffer = Find(bus, name, false);
                if(buffer.HasValue) break;
            }

            lock(sync)
            {
                if(hookAddress.HasValue && (hook != hookAddress || buffer != bufferAddress))
                {
                    cpu.RemoveHook(hookAddress.Value, OnCio);
                    hookAddress = null;
                }
                bufferAddress = buffer;
                if(hook.HasValue && buffer.HasValue && !hookAddress.HasValue)
                {
                    hookAddress = hook;
                    cpu.AddHook(hook.Value, OnCio);
                    this.Log(LogLevel.Info, "CIO: printf-Ausgabe aktiv (C$$IO$$ = 0x{0:X}, _CIOBUF_ = 0x{1:X})", hook.Value, buffer.Value);
                }
            }
        }

        // Symbole aus der ELF-Datei (ELF32, little endian): Name -> Wert
        private Dictionary<string, ulong> ElfSymbols(string[] wanted)
        {
            var result = new Dictionary<string, ulong>();
            if(string.IsNullOrEmpty(elfPath)) return result;
            try
            {
                var b = System.IO.File.ReadAllBytes(elfPath);
                if(b.Length < 52 || b[0] != 0x7F || b[1] != (byte)'E' || b[4] != 1) return result;
                uint shoff = BitConverter.ToUInt32(b, 0x20);
                int shentsize = BitConverter.ToUInt16(b, 0x2E);
                int shnum = BitConverter.ToUInt16(b, 0x30);
                for(int i = 0; i < shnum; i++)
                {
                    int sh = (int)shoff + i * shentsize;
                    if(BitConverter.ToUInt32(b, sh + 4) != 2) continue; // SHT_SYMTAB
                    uint off = BitConverter.ToUInt32(b, sh + 0x10);
                    uint size = BitConverter.ToUInt32(b, sh + 0x14);
                    uint link = BitConverter.ToUInt32(b, sh + 0x18);
                    int strSh = (int)shoff + (int)link * shentsize;
                    uint strOff = BitConverter.ToUInt32(b, strSh + 0x10);
                    for(uint e = off; e + 16 <= off + size; e += 16)
                    {
                        uint nameOff = BitConverter.ToUInt32(b, (int)e);
                        int start = (int)(strOff + nameOff), end = start;
                        while(end < b.Length && b[end] != 0) end++;
                        string name = Encoding.ASCII.GetString(b, start, end - start);
                        if(Array.IndexOf(wanted, name) >= 0 && !result.ContainsKey(name))
                        {
                            result[name] = BitConverter.ToUInt32(b, (int)e + 4);
                        }
                    }
                }
            }
            catch(Exception ex)
            {
                this.Log(LogLevel.Warning, "CIO: Symbole aus {0} nicht lesbar: {1}", elfPath, ex.Message);
            }
            return result;
        }

        // code: Thumb-Bit (Bit 0) der Code-Adresse entfernen; Daten (_CIOBUF_) dürfen ungerade liegen
        private static ulong? Find(IBusController bus, string name, bool code)
        {
            IEnumerable<ulong> addresses;
            if(bus.TryGetAllSymbolAddresses(name, out addresses))
            {
                foreach(var a in addresses)
                {
                    return code ? a & ~1UL : a;
                }
            }
            return null;
        }

        // Läuft im Simulationsthread, bevor der Befehl an C$$IO$$ ausgeführt wird
        private void OnCio(ICpuSupportingGdb cpu, ulong address)
        {
            ulong buf;
            lock(sync)
            {
                if(!bufferAddress.HasValue) return;
                buf = bufferAddress.Value;
            }
            var bus = machine.SystemBus;
            var head = bus.ReadBytes(buf, 13);
            uint length = BitConverter.ToUInt32(head, 0);
            byte command = head[4];
            var parm = new byte[8];
            Array.Copy(head, 5, parm, 0, 8);
            var data = length > 0 ? bus.ReadBytes(buf + 13, (int)Math.Min(length, MaxData)) : new byte[0];

            var result = new byte[8];
            byte[] reply = new byte[0];
            int fd = (short)(parm[0] | (parm[1] << 8));
            switch(command)
            {
                case DtOpen:
                    lock(sync) { PutShort(result, 0, nextFd++); }
                    break;
                case DtClose:
                    PutShort(result, 0, 0);
                    break;
                case DtRead:
                    PutShort(result, 0, 0); // Dateiende: keine Eingabe
                    break;
                case DtWrite:
                    lock(sync)
                    {
                        pending.AddRange(data);
                        history.AddRange(data);
                        if(pending.Count > MaxBuffer) pending.RemoveRange(0, pending.Count - MaxBuffer);
                        if(history.Count > MaxBuffer) history.RemoveRange(0, history.Count - MaxBuffer);
                    }
                    PutShort(result, 0, data.Length);
                    break;
                case DtLseek:
                    PutInt(result, 0, 0);
                    break;
                case DtUnlink:
                case DtRename:
                    PutShort(result, 0, -1);
                    break;
                case DtGetenv:
                    break; // leere Antwort = Variable nicht vorhanden
                case DtGetTime:
                    // Sekunden seit 1.1.1900 (TI-Zeitbasis)
                    PutInt(result, 0, (int)(uint)((DateTime.UtcNow - new DateTime(1900, 1, 1)).TotalSeconds));
                    break;
                case DtGetClk:
                    PutInt(result, 0, (int)(machine.LocalTimeSource.ElapsedVirtualTime.TotalMicroseconds / 1000));
                    break;
                default:
                    this.Log(LogLevel.Warning, "CIO: unbekannter Befehl 0x{0:X2} (fd {1})", command, fd);
                    PutShort(result, 0, -1);
                    break;
            }

            var answer = new byte[12 + reply.Length];
            BitConverter.GetBytes((uint)reply.Length).CopyTo(answer, 0);
            result.CopyTo(answer, 4);
            reply.CopyTo(answer, 12);
            bus.WriteBytes(answer, buf);
        }

        private static void PutShort(byte[] b, int i, int v)
        {
            b[i] = (byte)v;
            b[i + 1] = (byte)(v >> 8);
        }

        private static void PutInt(byte[] b, int i, int v)
        {
            BitConverter.GetBytes(v).CopyTo(b, i);
        }

        private const byte DtOpen = 0xF0, DtClose = 0xF1, DtRead = 0xF2, DtWrite = 0xF3, DtLseek = 0xF4,
                           DtUnlink = 0xF5, DtGetenv = 0xF6, DtRename = 0xF7, DtGetTime = 0xF8, DtGetClk = 0xF9;
        private const uint MaxData = 4096;
        private const int MaxBuffer = 16384;

        private readonly object sync = new object();
        private readonly IMachine machine;
        private readonly List<byte> pending = new List<byte>();
        private readonly List<byte> history = new List<byte>();
        private ulong? hookAddress;
        private ulong? bufferAddress;
        private int nextFd = 3;
        private string elfPath;
    }
}
