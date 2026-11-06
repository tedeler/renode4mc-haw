//
// SSD1306 OLED-Controller (I2C) als Renode-Peripherie mit auslesbarem Framebuffer.
// Wird zur Laufzeit per "include @SSD1306I2C.cs" kompiliert.
//
// Unterstützt: Control-Byte (Co/DC), Page-/Horizontal-/Vertical-Addressing,
// Column-/Page-Range, Display ON/OFF, Invert, Segment-Remap (A0/A1) und COM-Scanrichtung (C0/C8).
// Scrolling-Befehle werden akzeptiert, aber ignoriert.
//
// Ausrichtung: Wie bei den üblichen 0,96"-Modulen erscheint das Bild nur mit A1 + C8
// (Standard-Initialisierung, z. B. Adafruit/u8g2) aufrecht; ohne Remap steht es auf dem Kopf.
//
// Monitor (Framebuffer so, wie er auf dem Display zu sehen ist, im SSD1306-Page-Format:
// Byte = 8 senkrechte Pixel, Bit 0 oben, Index = Page * Breite + x):
//   sysbus.i2c0.oled GetFrame            -> "FB:<w>x<h>:<on><inv>:<base64>"
//   sysbus.i2c0.oled GetFrameIfChanged   -> wie oben oder "FB:SAME"
//
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.I2C;

namespace Antmicro.Renode.Peripherals.Video
{
    public class SSD1306I2C : II2CPeripheral
    {
        public SSD1306I2C(int width = 128, int height = 64)
        {
            if(width <= 0 || width > 128 || height <= 0 || height > 64 || height % 8 != 0)
            {
                throw new ArgumentException("Unsupported SSD1306 geometry");
            }
            Width = width;
            Height = height;
            pages = height / 8;
            gram = new byte[width * pages];
            args = new byte[8];
            Reset();
        }

        public int Width { get; private set; }
        public int Height { get; private set; }

        public bool DisplayOn
        {
            get { lock(sync) { return displayOn; } }
        }

        public bool Inverted
        {
            get { lock(sync) { return inverted; } }
        }

        public void Reset()
        {
            lock(sync)
            {
                Array.Clear(gram, 0, gram.Length);
                awaitingControl = true;
                isData = false;
                singleByte = false;
                pendingCommand = 0;
                argsNeeded = 0;
                argIndex = 0;
                addressingMode = 2; // Page Addressing nach Reset
                column = 0;
                page = 0;
                colStart = 0;
                colEnd = Width - 1;
                pageStart = 0;
                pageEnd = pages - 1;
                displayOn = false;
                inverted = false;
                segmentRemap = false;
                comScanReversed = false;
                version++;
            }
        }

        public void Write(byte[] data)
        {
            lock(sync)
            {
                foreach(var b in data)
                {
                    HandleByte(b);
                }
            }
        }

        public byte[] Read(int count = 1)
        {
            // SSD1306 über I2C ist praktisch write-only; Status-Byte 0x00
            return new byte[count];
        }

        public void FinishTransmission()
        {
            lock(sync)
            {
                awaitingControl = true;
            }
        }

        public string GetFrame()
        {
            lock(sync)
            {
                lastReported = version;
                return Encode();
            }
        }

        public string GetFrameIfChanged()
        {
            lock(sync)
            {
                if(version == lastReported)
                {
                    return "FB:SAME";
                }
                lastReported = version;
                return Encode();
            }
        }

        private string Encode()
        {
            return string.Format("FB:{0}x{1}:{2}{3}:{4}", Width, Height,
                displayOn ? 1 : 0, inverted ? 1 : 0, Convert.ToBase64String(View()));
        }

        // GRAM -> sichtbares Bild (Segment-Remap und COM-Scanrichtung berücksichtigen)
        private byte[] View()
        {
            if(segmentRemap && comScanReversed)
            {
                return (byte[])gram.Clone();
            }
            var view = new byte[gram.Length];
            for(int y = 0; y < Height; y++)
            {
                int sy = comScanReversed ? y : Height - 1 - y;
                for(int x = 0; x < Width; x++)
                {
                    int sx = segmentRemap ? x : Width - 1 - x;
                    if((gram[(sy >> 3) * Width + sx] & (1 << (sy & 7))) != 0)
                    {
                        view[(y >> 3) * Width + x] |= (byte)(1 << (y & 7));
                    }
                }
            }
            return view;
        }

        private void HandleByte(byte b)
        {
            if(awaitingControl)
            {
                singleByte = (b & 0x80) != 0; // Co
                isData = (b & 0x40) != 0;     // D/C#
                awaitingControl = false;
                return;
            }

            if(isData)
            {
                WriteData(b);
            }
            else
            {
                HandleCommandByte(b);
            }

            if(singleByte)
            {
                awaitingControl = true;
            }
        }

        private void HandleCommandByte(byte b)
        {
            if(argsNeeded > 0)
            {
                args[argIndex++] = b;
                argsNeeded--;
                if(argsNeeded == 0)
                {
                    ExecuteCommand(pendingCommand);
                }
                return;
            }

            var n = ArgumentCount(b);
            if(n > 0)
            {
                pendingCommand = b;
                argsNeeded = n;
                argIndex = 0;
                return;
            }
            ExecuteCommand(b);
        }

        private static int ArgumentCount(byte cmd)
        {
            switch(cmd)
            {
                case 0x20: case 0x81: case 0x8D: case 0xA8: case 0xD3:
                case 0xD5: case 0xD9: case 0xDA: case 0xDB:
                    return 1;
                case 0x21: case 0x22: case 0xA3:
                    return 2;
                case 0x29: case 0x2A:
                    return 5;
                case 0x26: case 0x27:
                    return 6;
                default:
                    return 0;
            }
        }

        private void ExecuteCommand(byte cmd)
        {
            if(cmd <= 0x0F)
            {
                column = (column & 0xF0) | (cmd & 0x0F);
                return;
            }
            if(cmd >= 0x10 && cmd <= 0x1F)
            {
                column = (column & 0x0F) | ((cmd & 0x0F) << 4);
                return;
            }
            if(cmd >= 0xB0 && cmd <= 0xB7)
            {
                page = cmd & 0x07;
                return;
            }

            switch(cmd)
            {
                case 0x20:
                    addressingMode = args[0] & 0x03;
                    break;
                case 0x21:
                    colStart = Math.Min(args[0] & 0x7F, Width - 1);
                    colEnd = Math.Min(args[1] & 0x7F, Width - 1);
                    column = colStart;
                    break;
                case 0x22:
                    pageStart = Math.Min(args[0] & 0x07, pages - 1);
                    pageEnd = Math.Min(args[1] & 0x07, pages - 1);
                    page = pageStart;
                    break;
                case 0xAE:
                    displayOn = false;
                    version++;
                    break;
                case 0xAF:
                    displayOn = true;
                    version++;
                    break;
                case 0xA6:
                    inverted = false;
                    version++;
                    break;
                case 0xA7:
                    inverted = true;
                    version++;
                    break;
                case 0xA0:
                case 0xA1:
                    segmentRemap = cmd == 0xA1;
                    version++;
                    break;
                case 0xC0:
                case 0xC8:
                    comScanReversed = cmd == 0xC8;
                    version++;
                    break;
                default:
                    this.Log(LogLevel.Noisy, "SSD1306: command 0x{0:X2} ignored", cmd);
                    break;
            }
        }

        private void WriteData(byte b)
        {
            if(page < pages && column < Width)
            {
                gram[page * Width + column] = b;
                version++;
            }

            switch(addressingMode)
            {
                case 0: // horizontal
                    column++;
                    if(column > colEnd)
                    {
                        column = colStart;
                        page++;
                        if(page > pageEnd)
                        {
                            page = pageStart;
                        }
                    }
                    break;
                case 1: // vertical
                    page++;
                    if(page > pageEnd)
                    {
                        page = pageStart;
                        column++;
                        if(column > colEnd)
                        {
                            column = colStart;
                        }
                    }
                    break;
                default: // page addressing
                    column++;
                    if(column >= Width)
                    {
                        column = 0;
                    }
                    break;
            }
        }

        private readonly object sync = new object();
        private readonly int pages;
        private readonly byte[] gram;
        private readonly byte[] args;

        private bool awaitingControl;
        private bool isData;
        private bool singleByte;
        private byte pendingCommand;
        private int argsNeeded;
        private int argIndex;

        private int addressingMode;
        private int column;
        private int page;
        private int colStart;
        private int colEnd;
        private int pageStart;
        private int pageEnd;
        private bool displayOn;
        private bool inverted;
        private bool segmentRemap;
        private bool comScanReversed;

        private ulong version;
        private ulong lastReported = ulong.MaxValue;
    }
}
