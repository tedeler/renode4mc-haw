#!/usr/bin/env python3
"""
check_header.py - prüft Simulator-Hardware und Beispiele gegen common/tm4c1294ncpdt.h (TI)

  python3 tools/check_header.py          (aus dem Repo-Wurzelverzeichnis oder von überall)

Checked are:
  1. sim/platforms/tm4c1294ncpdt.repl: base address, clock gating bit (RCGC...) and NVIC number of
     every peripheral module; NVIC base (EN0 must be at +0x100); the platforms generated from
     sim/experiments/*.json (tools/check_experiment.js, needs node) do not add chip peripherals again
     and do not use an address of the base platform a second time
  2. sim/models/*.cs: register offsets and bit constants of the models (named constants)
  3. common/startup_tm4c1294.c: every INT_ entry of the header file has its handler in the right place
  4. all .c/.h files in examples/, common/ and – if checked out – solutions/labs/ (except tm4c1294ncpdt.h):
     no self-defined addresses and no register/bit constants that the header already provides
Output: ERROR (mismatch), NOTE (not modelled/not connected), exit code 1 if there are errors.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fehler = []
hinweise = []
ok = 0


def pruefe(bedingung, text):
    global ok
    if bedingung:
        ok += 1
    else:
        fehler.append(text)


# ------------------------------------------------------------------------------------------------
# Headerdatei einlesen
# ------------------------------------------------------------------------------------------------
with open(os.path.join(ROOT, 'common', 'tm4c1294ncpdt.h'), encoding='ascii') as f:
    header = f.read().replace('\r', '').replace('\\\n', ' ')

REG = {}     # Name -> Adresse (alle ..._R, auch DATA_BITS_R)
KONST = {}   # Name -> Zahl (Bitfelder, INT_...)
KOMMENTAR = {}
for m in re.finditer(r'^#define\s+(\w+)\s+\((?:\*\()?\(volatile uint32_t \*\)(0x[0-9A-Fa-f]+)\)', header, re.M):
    REG[m.group(1)] = int(m.group(2), 16)
for m in re.finditer(r'^#define\s+(\w+)\s+(0x[0-9A-Fa-f]+|\d+)\s*(?://\s*(.*))?$', header, re.M):
    KONST[m.group(1)] = int(m.group(2), 0)
    KOMMENTAR[m.group(1)] = (m.group(3) or '').strip()
INT = {n[4:]: v for n, v in KONST.items() if n.startswith('INT_')}
ALLE_NAMEN = set(re.findall(r'^#define\s+(\w+)', header, re.M))   # jeder im Header definierte Name


def reg(name):
    if name not in REG:
        fehler.append(f'header: register {name} is missing')
        return None
    return REG[name]


def konst(name):
    if name not in KONST:
        fehler.append(f'header: constant {name} is missing')
        return None
    return KONST[name]


def bitnummer(maske):
    return maske.bit_length() - 1 if maske and maske & (maske - 1) == 0 else None


def rcgc_bit(register, kommentar_muster=None, nummer=None):
    """Bitnummer in SYSCTL_<register>_R<n> (z. B. RCGCGPIO, Port N -> 12)."""
    for name, wert in KONST.items():
        m = re.fullmatch(rf'SYSCTL_{register}_R(\d+)', name)
        if not m:
            continue
        if nummer is not None and int(m.group(1)) == nummer:
            return bitnummer(wert)
        if kommentar_muster and re.search(kommentar_muster, KOMMENTAR.get(name, '')):
            return bitnummer(wert)
    return None


# ------------------------------------------------------------------------------------------------
# 1. Plattform (.repl)
# ------------------------------------------------------------------------------------------------
def lies_repl(pfad):
    eintraege = []
    aktuell = None
    with open(pfad, encoding='utf-8') as f:
        for zeile in f:
            zeile = zeile.split('//')[0].rstrip()
            if not zeile.strip():
                continue
            m = re.match(r'^(\w+):\s*([\w.]+)\s*@\s*(\w+)\s*(?:<?\s*(0x[0-9A-Fa-f]+))?', zeile)
            if m:
                aktuell = {'name': m.group(1), 'typ': m.group(2), 'bus': m.group(3),
                           'adresse': int(m.group(4), 16) if m.group(4) else None, 'werte': {}, 'irq': {}}
                eintraege.append(aktuell)
                continue
            if aktuell is None or not zeile.startswith((' ', '\t')):
                aktuell = None
                continue
            m = re.match(r'^\s+(\w+):\s*"?([^"]*)"?$', zeile)
            if m:
                aktuell['werte'][m.group(1)] = m.group(2).strip()
            m = re.match(r'^\s+(\w+)\s*->\s*nvic@(\d+)', zeile)
            if m:
                aktuell['irq'][m.group(1)] = int(m.group(2))
    return eintraege


def pruefe_irq(e, anschluss, int_name):
    if int_name not in INT:
        if anschluss in e['irq']:
            fehler.append(f'repl {e["name"]}: {anschluss} -> nvic@{e["irq"][anschluss]}, but INT_{int_name} is missing in the header')
        return
    soll = INT[int_name] - 16
    if anschluss not in e['irq']:
        hinweise.append(f'repl {e["name"]}: {anschluss} not connected to the NVIC (INT_{int_name} = IRQ {soll})')
        return
    pruefe(e['irq'][anschluss] == soll,
           f'repl {e["name"]}: {anschluss} -> nvic@{e["irq"][anschluss]}, header INT_{int_name} - 16 = {soll}')


repl = lies_repl(os.path.join(ROOT, 'sim', 'platforms', 'tm4c1294ncpdt.repl'))
gesehen = set()
for e in repl:
    typ, name, adr = e['typ'], e['name'], e['adresse']
    if e['bus'] != 'sysbus' or adr is None:
        continue
    if typ.endswith('TivaGPIOPort'):
        port = e['werte'].get('portName', '?')
        gesehen.add(f'GPIO{port}')
        soll = REG.get(f'GPIO_PORT{port}_AHB_DATA_BITS_R', REG.get(f'GPIO_PORT{port}_DATA_BITS_R'))
        pruefe(soll == adr, f'repl {name}: address 0x{adr:08X}, header port {port} 0x{(soll or 0):08X}')
        bit = rcgc_bit('RCGCGPIO', rf'GPIO Port {port}\b')
        pruefe(bit == int(e['werte'].get('clockBit', -1)),
               f'repl {name}: clockBit {e["werte"].get("clockBit")}, header RCGCGPIO port {port} = bit {bit}')
        pruefe_irq(e, 'IRQ', f'GPIO{port}' if f'GPIO{port}' in INT else f'GPIO{port}0')
    elif typ.endswith('TivaTimer'):
        n = int(re.search(r'(\d+)$', name).group(1))
        gesehen.add(f'TIMER{n}')
        pruefe(reg(f'TIMER{n}_CFG_R') == adr, f'repl {name}: address 0x{adr:08X}, header TIMER{n}_CFG_R = 0x{REG.get(f"TIMER{n}_CFG_R", 0):08X}')
        pruefe(rcgc_bit('RCGCTIMER', nummer=n) == int(e['werte'].get('clockBit', -1)),
               f'repl {name}: clockBit {e["werte"].get("clockBit")} does not match SYSCTL_RCGCTIMER_R{n}')
        pruefe_irq(e, 'IRQA', f'TIMER{n}A')
        pruefe_irq(e, 'IRQB', f'TIMER{n}B')
    elif typ.endswith('TivaUART'):
        n = int(re.search(r'(\d+)$', name).group(1))
        gesehen.add(f'UART{n}')
        pruefe(reg(f'UART{n}_DR_R') == adr, f'repl {name}: address 0x{adr:08X}, header UART{n}_DR_R = 0x{REG.get(f"UART{n}_DR_R", 0):08X}')
        pruefe(rcgc_bit('RCGCUART', nummer=n) == int(e['werte'].get('clockBit', -1)),
               f'repl {name}: clockBit does not match SYSCTL_RCGCUART_R{n}')
        pruefe_irq(e, 'IRQ', f'UART{n}')
    elif typ.endswith('TivaI2C'):
        n = int(re.search(r'(\d+)$', name).group(1))
        gesehen.add(f'I2C{n}')
        pruefe(reg(f'I2C{n}_MSA_R') == adr, f'repl {name}: address 0x{adr:08X}, header I2C{n}_MSA_R = 0x{REG.get(f"I2C{n}_MSA_R", 0):08X}')
        pruefe(rcgc_bit('RCGCI2C', nummer=n) == int(e['werte'].get('clockBit', -1)),
               f'repl {name}: clockBit does not match SYSCTL_RCGCI2C_R{n}')
        pruefe_irq(e, 'IRQ', f'I2C{n}')
    elif typ.endswith('TivaSysCtl'):
        pruefe(reg('SYSCTL_DID0_R') == adr, f'repl {name}: address 0x{adr:08X}, header SYSCTL_DID0_R')
    elif typ.endswith('NVIC'):
        pruefe(reg('NVIC_EN0_R') - adr == 0x100,
               f'repl {name}: base 0x{adr:08X}, NVIC_EN0_R is not at base + 0x100')
        pruefe(reg('NVIC_ST_CTRL_R') - adr == 0x010,
               f'repl {name}: base 0x{adr:08X}, NVIC_ST_CTRL_R (SysTick) is not at base + 0x10')

# Versuchs-Plattformen erweitern die Basisplattform: Sie dürfen keine Peripherie an einer Adresse
# anlegen, die die Basis schon belegt, und keine Tiva-Peripherie neu anlegen (Adressen, Takt und IRQs
# der Chip-Peripherie stehen nur in tm4c1294ncpdt.repl). Die .repl werden aus sim/experiments/*.json
# erzeugt (tools/check_experiment.js --out); ungültige Versuchsdateien sind hier ein Fehler.
basis_adressen = {e['adresse']: e['name'] for e in repl if e['bus'] == 'sysbus' and e['adresse'] is not None}
node = shutil.which('node')
if not node:
    hinweise.append('node not found: experiment platforms (sim/experiments/*.json) not checked')
else:
    with tempfile.TemporaryDirectory() as gen:
        lauf = subprocess.run([node, os.path.join(ROOT, 'tools', 'check_experiment.js'), '-q', '--out', gen],
                              capture_output=True, text=True)
        pruefe(lauf.returncode == 0, 'tools/check_experiment.js: invalid experiment file(s)\n' + lauf.stdout.strip())
        for pfad in sorted(os.listdir(gen)):
            if not pfad.endswith('.repl'):
                continue
            json_name = pfad[:-5] + '.json'
            for e in lies_repl(os.path.join(gen, pfad)):
                if e['bus'] != 'sysbus' or e['adresse'] is None:
                    continue
                pruefe(e['adresse'] not in basis_adressen,
                       f'experiments/{json_name}: {e["name"]} @ 0x{e["adresse"]:08X} uses the same address as '
                       f'{basis_adressen.get(e["adresse"])} of the base platform')
                pruefe(not e['typ'].split('.')[-1].startswith('Tiva'),
                       f'experiments/{json_name}: {e["name"]} ({e["typ"]}) is a chip peripheral – it belongs in '
                       f'platforms/tm4c1294ncpdt.repl')

# Module des Headers, die im Simulator fehlen
for art, muster in (('GPIO', r'GPIO_PORT([A-Z])(?:_AHB)?_DATA_BITS_R'), ('TIMER', r'TIMER(\d)_CFG_R'),
                    ('UART', r'UART(\d)_DR_R'), ('I2C', r'I2C(\d)_MSA_R')):
    for name in REG:
        m = re.fullmatch(muster, name)
        if m and f'{art}{m.group(1)}' not in gesehen:
            hinweise.append(f'repl: {art}{m.group(1)} is defined in the header but not modelled')

# ------------------------------------------------------------------------------------------------
# 2. Modelle (C#): benannte Konstanten  Name = Wert
# ------------------------------------------------------------------------------------------------
def lies_konstanten(datei):
    with open(os.path.join(ROOT, 'sim', 'models', datei), encoding='utf-8') as f:
        text = f.read()
    werte = {}
    for m in re.finditer(r'private const (?:long|uint|int)\s+([^;]+);', text):
        for teil in m.group(1).split(','):
            if '=' not in teil:
                continue
            name, ausdruck = (' '.join(x.split()) for x in teil.split('=', 1))
            ausdruck = re.sub(r'(?<=[0-9A-Fa-f])u\b', '', ausdruck)
            try:
                werte[name] = eval(ausdruck, {'__builtins__': {}}, dict(werte))
            except Exception:
                pass
    return werte


def pruefe_modell(datei, basis_register, offsets, bits, masken=None, sysctl=None, praefix=None):
    k = lies_konstanten(datei)
    basis = reg(basis_register)
    praefix = praefix or basis_register.rsplit('_', 2)[0] + '_'
    for c_name, h_suffix in offsets.items():
        soll = reg(praefix + h_suffix + '_R')
        if soll is None:
            continue
        pruefe(k.get(c_name) == soll - basis,
               f'{datei}: {c_name} = {hex(k[c_name]) if c_name in k else "missing"}, '
               f'header {praefix}{h_suffix}_R = base + 0x{soll - basis:03X}')
    for c_name, h_name in bits.items():
        soll = konst(h_name)
        pruefe(k.get(c_name) == soll,
               f'{datei}: {c_name} = {hex(k[c_name]) if c_name in k else "missing"}, header {h_name} = {hex(soll or 0)}')
    for c_name, h_praefix in (masken or {}).items():
        erlaubt = 0
        for n, v in KONST.items():
            if n.startswith(h_praefix) and not n.endswith(('_M', '_S')):
                erlaubt |= v
        wert = k.get(c_name, 0)
        pruefe(wert & ~erlaubt == 0,
               f'{datei}: {c_name} = 0x{wert:X} contains bits that do not exist according to the header (0x{wert & ~erlaubt:X})')
    for c_name, h_name in (sysctl or {}).items():
        soll = reg(h_name)
        pruefe(k.get(c_name) == soll - reg('SYSCTL_DID0_R'),
               f'{datei}: {c_name} = {hex(k.get(c_name, -1))}, header {h_name} = SYSCTL + 0x{soll - REG["SYSCTL_DID0_R"]:03X}')
    return k


pruefe_modell('TivaGPIOPort.cs', 'GPIO_PORTA_AHB_DATA_BITS_R',
              {'Data': 'DATA', 'Dir': 'DIR', 'Is': 'IS', 'Ibe': 'IBE', 'Iev': 'IEV', 'Im': 'IM', 'Ris': 'RIS',
               'Mis': 'MIS', 'Icr': 'ICR', 'Afsel': 'AFSEL', 'Pur': 'PUR', 'Pdr': 'PDR', 'Den': 'DEN', 'Pctl': 'PCTL',
               'Pp': 'PP'},
              {}, sysctl={'RcgcGpio': 'SYSCTL_RCGCGPIO_R'}, praefix='GPIO_PORTA_AHB_')
pruefe_modell('TivaTimer.cs', 'TIMER0_CFG_R',
              {'Cfg': 'CFG', 'TamR': 'TAMR', 'TbmR': 'TBMR', 'Ctl': 'CTL', 'Sync': 'SYNC', 'Imr': 'IMR',
               'Ris': 'RIS', 'Mis': 'MIS', 'Icr': 'ICR', 'TailR': 'TAILR', 'TbilR': 'TBILR',
               'TamatchR': 'TAMATCHR', 'TbmatchR': 'TBMATCHR', 'TapR': 'TAPR', 'TbpR': 'TBPR', 'TapmR': 'TAPMR',
               'TbpmR': 'TBPMR', 'TaR': 'TAR', 'TbR': 'TBR', 'TaV': 'TAV', 'TbV': 'TBV', 'TaPs': 'TAPS', 'TbPs': 'TBPS',
               'Pp': 'PP', 'Cc': 'CC'},
              {'CfgMask': 'TIMER_CFG_M', 'TnmrMask': 'TIMER_TAMR_TAMR_M', 'TnmrOneShot': 'TIMER_TAMR_TAMR_1_SHOT',
               'TnmrPeriodic': 'TIMER_TAMR_TAMR_PERIOD', 'TnmrCapture': 'TIMER_TAMR_TAMR_CAP',
               'MrCmr': 'TIMER_TAMR_TACMR', 'MrTcact': 'TIMER_TAMR_TCACT_M', 'MrAms': 'TIMER_TAMR_TAAMS', 'MrCdir': 'TIMER_TAMR_TACDIR',
               'MrMie': 'TIMER_TAMR_TAMIE', 'MrWot': 'TIMER_TAMR_TAWOT', 'MrSnaps': 'TIMER_TAMR_TASNAPS',
               'MrIld': 'TIMER_TAMR_TAILD', 'MrPwmie': 'TIMER_TAMR_TAPWMIE', 'MrMrsu': 'TIMER_TAMR_TAMRSU',
               'MrPlo': 'TIMER_TAMR_TAPLO', 'MrCintd': 'TIMER_TAMR_TACINTD',
               'CtlTaen': 'TIMER_CTL_TAEN', 'CtlTastall': 'TIMER_CTL_TASTALL', 'CtlTben': 'TIMER_CTL_TBEN',
               'CtlTbstall': 'TIMER_CTL_TBSTALL', 'CtlTaevent': 'TIMER_CTL_TAEVENT_M', 'CtlTbevent': 'TIMER_CTL_TBEVENT_M',
               'CtlTapwml': 'TIMER_CTL_TAPWML', 'CtlTbpwml': 'TIMER_CTL_TBPWML', 'RisTatoris': 'TIMER_RIS_TATORIS',
               'RisTbtoris': 'TIMER_RIS_TBTORIS', 'RisCaeris': 'TIMER_RIS_CAERIS', 'RisCberis': 'TIMER_RIS_CBERIS',
               'ImTatoim': 'TIMER_IMR_TATOIM', 'ImTbtoim': 'TIMER_IMR_TBTOIM', 'ImCaeim': 'TIMER_IMR_CAEIM',
               'ImCbeim': 'TIMER_IMR_CBEIM', 'RisTamris': 'TIMER_RIS_TAMRIS', 'RisTbmris': 'TIMER_RIS_TBMRIS',
               'ImTamim': 'TIMER_IMR_TAMIM', 'ImTbmim': 'TIMER_IMR_TBMIM'},
              masken={'ImrMask': 'TIMER_IMR_', 'MrMask': 'TIMER_TAMR_'}, sysctl={'RcgcTimer': 'SYSCTL_RCGCTIMER_R'})
pruefe_modell('TivaUART.cs', 'UART0_DR_R',
              {'Dr': 'DR', 'Rsr': 'RSR', 'Fr': 'FR', 'Ilpr': 'ILPR', 'Ibrd': 'IBRD', 'Fbrd': 'FBRD', 'Lcrh': 'LCRH',
               'Ctl': 'CTL', 'Ifls': 'IFLS', 'Im': 'IM', 'Ris': 'RIS', 'Mis': 'MIS', 'Icr': 'ICR', 'Dmactl': 'DMACTL',
               'Pp': 'PP', 'Cc': 'CC'},
              {'FrBusy': 'UART_FR_BUSY', 'FrRxfe': 'UART_FR_RXFE', 'FrTxff': 'UART_FR_TXFF',
               'FrRxff': 'UART_FR_RXFF', 'FrTxfe': 'UART_FR_TXFE', 'LcrhBrk': 'UART_LCRH_BRK',
               'LcrhPen': 'UART_LCRH_PEN', 'LcrhEps': 'UART_LCRH_EPS', 'LcrhStp2': 'UART_LCRH_STP2',
               'LcrhFen': 'UART_LCRH_FEN', 'LcrhSps': 'UART_LCRH_SPS', 'CtlUarten': 'UART_CTL_UARTEN', 'CtlSiren': 'UART_CTL_SIREN', 'CtlSmart': 'UART_CTL_SMART',
               'CtlEot': 'UART_CTL_EOT', 'CtlHse': 'UART_CTL_HSE', 'CtlLbe': 'UART_CTL_LBE',
               'CtlTxe': 'UART_CTL_TXE', 'CtlRxe': 'UART_CTL_RXE',
               'IntRx': 'UART_RIS_RXRIS', 'IntTx': 'UART_RIS_TXRIS', 'IntRt': 'UART_RIS_RTRIS',
               'IntFe': 'UART_RIS_FERIS', 'IntPe': 'UART_RIS_PERIS', 'IntBe': 'UART_RIS_BERIS',
               'IntOe': 'UART_RIS_OERIS', 'RsrOe': 'UART_RSR_OE', 'DrFe': 'UART_DR_FE', 'DrPe': 'UART_DR_PE',
               'DrBe': 'UART_DR_BE', 'DrOe': 'UART_DR_OE', 'CcPiosc': 'UART_CC_CS_PIOSC'},
              masken={'ImMask': 'UART_IM_'}, sysctl={'RcgcUart': 'SYSCTL_RCGCUART_R'})
pruefe_modell('TivaI2C.cs', 'I2C0_MSA_R',
              {'Msa': 'MSA', 'Mcs': 'MCS', 'Mdr': 'MDR', 'Mtpr': 'MTPR', 'Mimr': 'MIMR', 'Mris': 'MRIS',
               'Mmis': 'MMIS', 'Micr': 'MICR', 'Mcr': 'MCR', 'Mclkocnt': 'MCLKOCNT', 'Mbmon': 'MBMON',
               'Pp': 'PP', 'Pc': 'PC'},
              {'CmdRun': 'I2C_MCS_RUN', 'CmdStart': 'I2C_MCS_START', 'CmdStop': 'I2C_MCS_STOP',
               'CmdAck': 'I2C_MCS_ACK', 'StBusy': 'I2C_MCS_BUSY', 'StError': 'I2C_MCS_ERROR',
               'StAdrAck': 'I2C_MCS_ADRACK', 'StDatAck': 'I2C_MCS_DATACK', 'StIdle': 'I2C_MCS_IDLE',
               'StBusBsy': 'I2C_MCS_BUSBSY', 'McrMfe': 'I2C_MCR_MFE'},
              sysctl={'RcgcI2c': 'SYSCTL_RCGCI2C_R'})
k = pruefe_modell('TivaSysCtl.cs', 'SYSCTL_DID0_R', {},
                  {'RsclkcfgMemtimu': 'SYSCTL_RSCLKCFG_MEMTIMU', 'RsclkcfgNewfreq': 'SYSCTL_RSCLKCFG_NEWFREQ',
                   'RsclkcfgUsepll': 'SYSCTL_RSCLKCFG_USEPLL', 'PllstatLock': 'SYSCTL_PLLSTAT_LOCK',
                   'RisPlllris': 'SYSCTL_RIS_PLLLRIS', 'RisMoscpupris': 'SYSCTL_RIS_MOSCPUPRIS'},
                  sysctl={'Did0': 'SYSCTL_DID0_R', 'Did1': 'SYSCTL_DID1_R', 'RcgcBase': 'SYSCTL_RCGCWD_R',
                          'Ris': 'SYSCTL_RIS_R', 'Rsclkcfg': 'SYSCTL_RSCLKCFG_R', 'Pllfreq0': 'SYSCTL_PLLFREQ0_R',
                          'Pllfreq1': 'SYSCTL_PLLFREQ1_R', 'Pllstat': 'SYSCTL_PLLSTAT_R',
                          'ScgcBase': 'SYSCTL_SCGCWD_R', 'DcgcBase': 'SYSCTL_DCGCWD_R', 'PrBase': 'SYSCTL_PRWD_R'})
soll_did0 = sum(konst(n) or 0 for n in ('SYSCTL_DID0_VER_1', 'SYSCTL_DID0_CLASS_TM4C129'))
pruefe(k.get('Did0Value', 0) & (konst('SYSCTL_DID0_VER_M') | konst('SYSCTL_DID0_CLASS_M')) == soll_did0,
       f'TivaSysCtl.cs: DID0 = 0x{k.get("Did0Value", 0):08X}, VER/CLASS according to the header 0x{soll_did0:08X} (TM4C129)')
soll_did1 = konst('SYSCTL_DID1_PRTNO_TM4C1294NCPDT') | konst('SYSCTL_DID1_PINCNT_128')
pruefe(k.get('Did1Value', 0) & (konst('SYSCTL_DID1_PRTNO_M') | konst('SYSCTL_DID1_PINCNT_M')) == soll_did1,
       f'TivaSysCtl.cs: DID1 = 0x{k.get("Did1Value", 0):08X}, PRTNO/PINCNT according to the header 0x{soll_did1:08X} '
       f'(TM4C1294NCPDT, 128 pins)')
# Alle RCGC-/PR-Register des Headers müssen im gespiegelten Bereich liegen
groesster = max(a - REG['SYSCTL_RCGCWD_R'] for n, a in REG.items() if re.fullmatch(r'SYSCTL_RCGC\w+_R', n))
pruefe(k.get('RegisterCount', 0) * 4 > groesster,
       f'TivaSysCtl.cs: RegisterCount = {k.get("RegisterCount")} only covers RCGC offsets up to '
       f'0x{k.get("RegisterCount", 0) * 4 - 4:02X}, the header goes up to 0x{groesster:02X} (e.g. RCGCEMAC)')

# ------------------------------------------------------------------------------------------------
# 3. Vektortabelle
# ------------------------------------------------------------------------------------------------
with open(os.path.join(ROOT, 'common', 'startup_tm4c1294.c'), encoding='utf-8') as f:
    startup = f.read()
tabelle = dict(re.findall(r'\[INT_(\w+)\]\s*=\s*(\w+)', startup))
for name in INT:
    pruefe(tabelle.get(name) == f'{name}_Handler',
           f'startup: INT_{name} has handler {tabelle.get(name, "none")}, expected {name}_Handler')
for name in tabelle:
    pruefe(name in INT, f'startup: [INT_{name}] does not exist in the header')

# ------------------------------------------------------------------------------------------------
# 4. Keine Adressen im Code
# ------------------------------------------------------------------------------------------------
# alle C-Quellen und eigenen Header in common/, examples/ und den Labor-Musterlösungen im privaten
# Submodul solutions/ (nur wenn ausgecheckt; auch Projekte mit mehreren Dateien);
# ausgenommen ist nur der TI-Header selbst
dateien = []
for wurzel in (os.path.join(ROOT, 'common'), os.path.join(ROOT, 'examples'), os.path.join(ROOT, 'solutions', 'labs')):
    for verz, _, namen in sorted(os.walk(wurzel)):
        for name in sorted(namen):
            if name.endswith(('.c', '.h')) and name != 'tm4c1294ncpdt.h':
                dateien.append(os.path.join(verz, name))
# Präfixe der Peripheriemodule im Header: eigene Namen tragen sie nicht (Pins z. B. PINS_UART0),
# damit man im Code sofort sieht, was von TI kommt. Erlaubt ist so ein Name nur, wenn er aus
# Header-Namen zusammengesetzt ist.
MODUL_PRAEFIX = re.compile(r'^(?:SYSCTL|GPIO|TIMER|WTIMER|UART|I2C|SSI|NVIC|ADC|PWM|QEI|USB|EMAC|EPHY|EEPROM|'
                           r'FLASH|HIB|WATCHDOG|WDT|CAN|COMP|UDMA|DMA|EPI|CRC|SHA|AES|DES|LCD|ONEWIRE|SYSEXC|'
                           r'PECI|FAN|INT|NVIC|SYSTICK|FPU|MPU|CPAC|DEBUG|SCB|PORT)_')
for p in dateien:
    rel = os.path.relpath(p, ROOT)
    with open(p, encoding='utf-8') as f:
        text = f.read()
    # Kommentare entfernen (Zeilennummern bleiben erhalten), Fortsetzungszeilen zusammenfassen
    ohne = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), text, flags=re.S)
    ohne = re.sub(r'//[^\n]*', '', ohne)
    for nr, zeile in enumerate(ohne.split('\n'), 1):
        treffer = re.search(r'0x(?:4[0-9A-Fa-f]{7}|E000[0-9A-Fa-f]{4}|2[02][0-9A-Fa-f]{6})|\bREG\s*\(|'
                            r'volatile\s+uint32_t\s*\*\s*\)', zeile)
        pruefe(treffer is None, f'{rel}:{nr}: address in the code: {zeile.strip()}')
    logisch = re.sub(r'\\\n', ' ', ohne)
    for m in re.finditer(r'^[ \t]*#[ \t]*define[ \t]+(\w+)(\([^)]*\))?([^\n]*)', logisch, re.M):
        name, wert = m.group(1), m.group(3).strip()
        nr = ohne[:ohne.find(m.group(0).split('\n')[0].strip())].count('\n') + 1
        pruefe(name not in ALLE_NAMEN,
               f'{rel}:{nr}: {name} is already defined in tm4c1294ncpdt.h – do not define it again')
        if name not in ALLE_NAMEN and MODUL_PRAEFIX.match(name):
            pruefe(any(w in ALLE_NAMEN for w in re.findall(r'\b[A-Z_][A-Z0-9_]*\b', wert)),
                   f'{rel}:{nr}: own register constant {name} = {wert} – use the header constant')

# ------------------------------------------------------------------------------------------------
for h in hinweise:
    print('NOTE ', h)
for e in fehler:
    print('ERROR', e)
print(f'{ok} checks passed, {len(fehler)} errors, {len(hinweise)} notes')
sys.exit(1 if fehler else 0)
