```
System:
  Kernel: 6.14.0-37-generic arch: x86_64 bits: 64 compiler: gcc v: 13.3.0 clocksource: tsc
  Desktop: Cinnamon v: 6.4.8 tk: GTK v: 3.24.41 wm: Muffin v: 6.4.1 vt: 7 dm: LightDM v: 1.30.0
    Distro: Linux Mint 22.2 Zara base: Ubuntu 24.04 noble
Machine:
  Type: Desktop Mobo: ASUSTeK model: TUF GAMING X570-PLUS (WI-FI) v: Rev X.0x
    serial: <superuser required> part-nu: SKU uuid: <superuser required> UEFI: American Megatrends
    v: 3001 date: 12/04/2020
CPU:
  Info: 8-core model: AMD Ryzen 7 3800X bits: 64 type: MT MCP smt: enabled arch: Zen 2 rev: 0
    cache: L1: 512 KiB L2: 4 MiB L3: 32 MiB
  Speed (MHz): avg: 3199 high: 4043 min/max: 550/4559 boost: enabled cores: 1: 2224 2: 3593
    3: 2224 4: 2224 5: 4039 6: 4043 7: 3590 8: 3593 9: 2224 10: 3385 11: 2224 12: 2224 13: 4042
    14: 4042 15: 3882 16: 3639 bogomips: 124565
  Flags: avx avx2 ht lm nx pae sse sse2 sse3 sse4_1 sse4_2 sse4a ssse3 svm
Graphics:
  Device-1: NVIDIA TU104 [GeForce RTX 2070 SUPER] vendor: Micro-Star MSI driver: nvidia
    v: 580.95.05 arch: Turing pcie: speed: 2.5 GT/s lanes: 16 ports: active: none off: DP-3
    empty: DP-1,DP-2,HDMI-A-1 bus-ID: 0a:00.0 chip-ID: 10de:1e84 class-ID: 0300
  Display: x11 server: X.Org v: 21.1.11 with: Xwayland v: 23.2.6 driver: X: loaded: nvidia
    unloaded: fbdev,modesetting,nouveau,vesa gpu: nv_platform,nvidia,nvidia-nvswitch display-ID: :0
    screens: 1
  Screen-1: 0 s-res: 2560x1440 s-dpi: 108 s-size: 602x341mm (23.70x13.43") s-diag: 692mm (27.24")
  Monitor-1: DP-3 mapped: DP-4 note: disabled model: ViewSonic VX2719-2K-PRO serial: <filter>
    res: 2560x1440 hz: 60 dpi: 109 size: 597x336mm (23.5x13.23") diag: 685mm (27") modes:
    max: 2560x1440 min: 640x480
  API: EGL v: 1.5 hw: drv: nvidia nouveau drv: nvidia platforms: device: 0 drv: nvidia device: 1
    drv: nouveau device: 2 drv: swrast gbm: drv: nvidia surfaceless: drv: nvidia x11: drv: nvidia
    inactive: wayland
  API: OpenGL v: 4.6.0 compat-v: 4.5 vendor: nvidia mesa v: 580.95.05 glx-v: 1.4
    direct-render: yes renderer: NVIDIA GeForce RTX 2070 SUPER/PCIe/SSE2
Audio:
  Device-1: NVIDIA TU104 HD Audio vendor: Micro-Star MSI driver: snd_hda_intel v: kernel pcie:
    speed: 8 GT/s lanes: 16 bus-ID: 0a:00.1 chip-ID: 10de:10f8 class-ID: 0403
  Device-2: AMD Starship/Matisse HD Audio vendor: ASUSTeK driver: snd_hda_intel v: kernel pcie:
    speed: 16 GT/s lanes: 16 bus-ID: 0c:00.4 chip-ID: 1022:1487 class-ID: 0403
  API: ALSA v: k6.14.0-37-generic status: kernel-api
  Server-1: PipeWire v: 1.0.5 status: active with: 1: pipewire-pulse status: active
    2: wireplumber status: active
Network:
  Device-1: Intel Wi-Fi 5 Wireless-AC 9x6x [Thunder Peak] driver: iwlwifi v: kernel pcie:
    speed: 5 GT/s lanes: 1 bus-ID: 05:00.0 chip-ID: 8086:2526 class-ID: 0280
  IF: wlp5s0 state: up mac: <filter>
  Device-2: Realtek RTL8111/8168/8211/8411 PCI Express Gigabit Ethernet
    vendor: ASUSTeK RTL8111/8168/8411 driver: r8169 v: kernel pcie: speed: 2.5 GT/s lanes: 1
    port: f000 bus-ID: 06:00.0 chip-ID: 10ec:8168 class-ID: 0200
  IF: enp6s0 state: down mac: <filter>
  IF-ID-1: Meta state: unknown speed: 10000 Mbps duplex: full mac: N/A
Bluetooth:
  Device-1: Intel Wireless-AC 9260 Bluetooth Adapter driver: btusb v: 0.8 type: USB rev: 2.0
    speed: 12 Mb/s lanes: 1 bus-ID: 3-5:2 chip-ID: 8087:0025 class-ID: e001
  Report: hciconfig ID: hci0 rfk-id: 0 state: up address: <filter> bt-v: 5.1 lmp-v: 10 sub-v: 100
    hci-v: 10 rev: 100 class-ID: 7c0104
Drives:
  Local Storage: total: 5.71 TiB used: 187.98 GiB (3.2%)
  ID-1: /dev/nvme0n1 vendor: Western Digital model: WDS100T2B0C-00PXH0 size: 931.51 GiB
    speed: 31.6 Gb/s lanes: 4 tech: SSD serial: <filter> fw-rev: 211070WD temp: 28.9 C scheme: GPT
  ID-2: /dev/nvme1n1 vendor: Intel model: SSDPEKKW256G8 size: 238.47 GiB speed: 31.6 Gb/s
    lanes: 4 tech: SSD serial: <filter> fw-rev: 004C temp: 32.9 C scheme: GPT
  ID-3: /dev/sda vendor: Western Digital model: WD40PURX-69AKYY0 size: 3.64 TiB speed: 6.0 Gb/s
    tech: HDD rpm: 5400 serial: <filter> fw-rev: 0B80 scheme: GPT
  ID-4: /dev/sdb model: Great Wall GW560 1TB size: 953.87 GiB speed: 6.0 Gb/s tech: SSD
    serial: <filter> fw-rev: 18B7 scheme: GPT
Partition:
  ID-1: / size: 937.33 GiB used: 187.94 GiB (20.1%) fs: ext4 dev: /dev/sdb2
  ID-2: /boot/efi size: 96 MiB used: 37.1 MiB (38.6%) fs: vfat dev: /dev/nvme0n1p1
Swap:
  ID-1: swap-1 type: file size: 2 GiB used: 0 KiB (0.0%) priority: -2 file: /swapfile
USB:
  Hub-1: 1-0:1 info: hi-speed hub with single TT ports: 6 rev: 2.0 speed: 480 Mb/s lanes: 1
    chip-ID: 1d6b:0002 class-ID: 0900
  Hub-2: 2-0:1 info: super-speed hub ports: 4 rev: 3.1 speed: 10 Gb/s lanes: 1 chip-ID: 1d6b:0003
    class-ID: 0900
  Hub-3: 3-0:1 info: hi-speed hub with single TT ports: 6 rev: 2.0 speed: 480 Mb/s lanes: 1
    chip-ID: 1d6b:0002 class-ID: 0900
  Device-1: 3-5:2 info: Intel Wireless-AC 9260 Bluetooth Adapter type: bluetooth driver: btusb
    interfaces: 2 rev: 2.0 speed: 12 Mb/s lanes: 1 power: 100mA chip-ID: 8087:0025 class-ID: e001
  Device-2: 3-6:3 info: ASUSTek AURA LED Controller type: HID driver: hid-generic,usbhid
    interfaces: 2 rev: 2.0 speed: 12 Mb/s lanes: 1 power: 16mA chip-ID: 0b05:18f3 class-ID: 0300
    serial: <filter>
  Hub-4: 4-0:1 info: super-speed hub ports: 4 rev: 3.1 speed: 10 Gb/s lanes: 1 chip-ID: 1d6b:0003
    class-ID: 0900
  Hub-5: 5-0:1 info: hi-speed hub with single TT ports: 2 rev: 2.0 speed: 480 Mb/s lanes: 1
    chip-ID: 1d6b:0002 class-ID: 0900
  Hub-6: 6-0:1 info: super-speed hub ports: 4 rev: 3.1 speed: 10 Gb/s lanes: 1 chip-ID: 1d6b:0003
    class-ID: 0900
  Hub-7: 7-0:1 info: hi-speed hub with single TT ports: 4 rev: 2.0 speed: 480 Mb/s lanes: 1
    chip-ID: 1d6b:0002 class-ID: 0900
  Hub-8: 7-2:2 info: Realtek RTS5411 Hub ports: 4 rev: 2.1 speed: 480 Mb/s lanes: 1
    chip-ID: 0bda:5411 class-ID: 0900
  Device-1: 7-3:3 info: Logitech Gaming Keyboard G610 type: keyboard,HID
    driver: hid-generic,usbhid interfaces: 2 rev: 2.0 speed: 12 Mb/s lanes: 1 power: 500mA
    chip-ID: 046d:c338 class-ID: 0300 serial: <filter>
  Device-2: 7-4:4 info: ASUSTek ROG OMNI RECEIVER type: keyboard,mouse,HID
    driver: hid-generic,usbhid interfaces: 4 rev: 2.0 speed: 12 Mb/s lanes: 1 power: 500mA
    chip-ID: 0b05:1ace class-ID: 0300 serial: <filter>
  Hub-9: 8-0:1 info: super-speed hub ports: 4 rev: 3.1 speed: 10 Gb/s lanes: 1 chip-ID: 1d6b:0003
    class-ID: 0900
  Hub-10: 8-2:2 info: Realtek Hub ports: 4 rev: 3.1 speed: 5 Gb/s lanes: 1 chip-ID: 0bda:0411
    class-ID: 0900
Sensors:
  System Temperatures: cpu: 32.0 C mobo: 30.2 C gpu: nvidia temp: 31 C
  Fan Speeds (rpm): N/A gpu: nvidia fan: 0%
Repos:
  Packages: pm: dpkg pkgs: 2330
  No active apt repos in: /etc/apt/sources.list
  Active apt repos in: /etc/apt/sources.list.d/official-package-repositories.list
    1: deb https: //mirrors.aliyun.com/linuxmint-packages zara main upstream import backport
    2: deb http: //mirrors.aliyun.com/ubuntu noble main restricted universe multiverse
    3: deb http: //mirrors.aliyun.com/ubuntu noble-updates main restricted universe multiverse
    4: deb http: //mirrors.aliyun.com/ubuntu noble-backports main restricted universe multiverse
    5: deb http: //security.ubuntu.com/ubuntu/ noble-security main restricted universe multiverse
  No active apt repos in: /etc/apt/sources.list.d/steam-beta.list
  Active apt repos in: /etc/apt/sources.list.d/steam-stable.list
    1: deb [arch=amd64,i386 signed-by=/usr/share/keyrings/steam.gpg] https: //repo.steampowered.com/steam/ stable steam
    2: deb-src [arch=amd64,i386 signed-by=/usr/share/keyrings/steam.gpg] https: //repo.steampowered.com/steam/ stable steam
  Active apt repos in: /etc/apt/sources.list.d/vivaldi.list
    1: deb [arch=amd64] https: //repo.vivaldi.com/stable/deb/ stable main
  Active apt repos in: /etc/apt/sources.list.d/wezterm.list
    1: deb [signed-by=/usr/share/keyrings/wezterm-fury.gpg] https: //apt.fury.io/wez/ * *
  Active apt repos in: /etc/apt/sources.list.d/vscode.sources
    1: deb [arch=amd64] https: //packages.microsoft.com/repos/code stable main
Info:
  Memory: total: 64 GiB note: est. available: 62.71 GiB used: 8.54 GiB (13.6%)
  Processes: 451 Power: uptime: 7h 48m states: freeze,mem,disk suspend: deep wakeups: 0
    hibernate: platform Init: systemd v: 255 target: graphical (5) default: graphical
  Compilers: gcc: 13.3.0 Client: Cinnamon v: 6.4.8 inxi: 3.3.34
```