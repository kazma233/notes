# 前提

关闭安全启动 Secure Boot

# 看先当前状态
`inxi -G`

# 屏蔽 nouveau

``` bash
sudo tee /etc/modprobe.d/blacklist-nouveau.conf > /dev/null << EOF
blacklist nouveau
blacklist lbm-nouveau
options nouveau modeset=0
alias nouveau off
alias lbm-nouveau off
EOF
```

# 更新内核初始化镜像

`sudo update-initramfs -u -k all`

# 重启

`sudo reboot`

# 无输出，成功

`lsmod | grep nouveau`

# 正确展示 be like

```
Graphics:
  Device-1: NVIDIA TU104 [GeForce RTX 2070 SUPER] driver: nvidia v: 570.195.03
  Display: x11 server: X.Org v: 21.1.11 with: Xwayland v: 23.2.6 driver: X:
    loaded: nvidia unloaded: fbdev,modesetting,nouveau,vesa
    gpu: nvidia,nvidia-nvswitch resolution: 2560x1440~60Hz
  API: EGL v: 1.5 drivers: nouveau,nvidia,swrast
    platforms: gbm,x11,surfaceless,device
  API: OpenGL v: 4.6.0 compat-v: 4.5 vendor: nvidia mesa v: 570.195.03
    renderer: NVIDIA GeForce RTX 2070 SUPER/PCIe/SSE2
```