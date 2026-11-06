// Tastenmatrix (Keypad) mit elektrisch nachgebildetem Multiplexing.
//
// Aufbau wie ein echtes Folien-Keypad (Standard: 4 Zeilen x 3 Spalten):
//   * Die Zeilenleitungen (Rows) kommen von GPIO-AUSGÄNGEN des Mikrocontrollers:
//       gpioK:  0 -> keypad@0  ...  3 -> keypad@3
//   * Die Spaltenleitungen (Cols) gehen auf GPIO-EINGÄNGE (mit Pull-down):
//       keypad: Col0 -> gpioK@4  ...  Col2 -> gpioK@6
//   * Eine gedrückte Taste (r, c) verbindet Zeile r mit Spalte c:
//       Pegel Spalte c = ODER über alle Zeilen r mit (Zeile r ist HIGH) UND (Taste r,c gedrückt)
//
// Damit funktionieren beide üblichen Verfahren der Firmware:
//   1. Zeilen-Scan: nacheinander eine Zeile HIGH setzen und die Spalten lesen
//   2. Interrupt: alle Zeilen HIGH, Flanken-Interrupt auf den Spalten; in der ISR scannen
//
// Bedienung im Renode-Monitor (bzw. per Klick in der Web-Konsole):
//   keypad SetKey 1 1 true      (Zeile 1, Spalte 1 = Taste "5" drücken)
//   keypad SetKey 1 1 false     (loslassen)
//   keypad ReleaseAll
using System;
using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    public class KeypadMatrix : IGPIOReceiver
    {
        public KeypadMatrix(int rows = 4, int columns = 3)
        {
            if(rows < 1 || rows > 8 || columns < 1 || columns > 4)
            {
                throw new ArgumentException("KeypadMatrix: 1..8 Zeilen und 1..4 Spalten");
            }
            Rows = rows;
            Columns = columns;
            Col0 = new GPIO();
            Col1 = new GPIO();
            Col2 = new GPIO();
            Col3 = new GPIO();
            Reset();
        }

        public int Rows { get; private set; }
        public int Columns { get; private set; }

        // Spaltenausgänge (zum GPIO-Eingang des Mikrocontrollers)
        public GPIO Col0 { get; private set; }
        public GPIO Col1 { get; private set; }
        public GPIO Col2 { get; private set; }
        public GPIO Col3 { get; private set; }

        // Zeileneingänge: number = Zeile, value = Pegel des GPIO-Ausgangs
        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number >= Rows) return;
            lock(sync)
            {
                rowLevel[number] = value;
                Update();
            }
        }

        public void SetKey(int row, int column, bool pressed)
        {
            if(row < 0 || row >= Rows || column < 0 || column >= Columns)
            {
                throw new ArgumentException(string.Format("Taste ({0},{1}) existiert nicht", row, column));
            }
            lock(sync)
            {
                this.Log(LogLevel.Debug, "Keypad: Zeile {0}, Spalte {1} {2}", row, column, pressed ? "gedrückt" : "losgelassen");
                pressedKeys[row, column] = pressed;
                Update();
            }
        }

        public void Press(int row, int column)
        {
            SetKey(row, column, true);
        }

        public void Release(int row, int column)
        {
            SetKey(row, column, false);
        }

        public void ReleaseAll()
        {
            lock(sync)
            {
                pressedKeys = new bool[Rows, Columns];
                Update();
            }
        }

        // Aktueller Pegel einer Spalte (zur Kontrolle im Monitor)
        public bool GetColumn(int column)
        {
            lock(sync) { return column >= 0 && column < Columns && ColumnLevel(column); }
        }

        public void Reset()
        {
            lock(sync)
            {
                rowLevel = new bool[Rows];
                pressedKeys = new bool[Rows, Columns];
                Update();
            }
        }

        private bool ColumnLevel(int c)
        {
            for(int r = 0; r < Rows; r++)
            {
                if(rowLevel[r] && pressedKeys[r, c]) return true;
            }
            return false;
        }

        private void Update()
        {
            var outputs = new[] { Col0, Col1, Col2, Col3 };
            for(int c = 0; c < Columns; c++)
            {
                outputs[c].Set(ColumnLevel(c));
            }
        }

        private readonly object sync = new object();
        private bool[] rowLevel;
        private bool[,] pressedKeys;
    }
}
