``` bash
# https://www.qemu.org/download/#linux
sudo apt-get install qemu-system
sudo apt-get install samba vde2
sudo apt-get install libvirt-daemon-system

sudo usermod -aG libvirt $USER
sudo usermod -aG kvm $USER

sudo systemctl enable --now libvirtd
sudo systemctl start libvirtd
sudo systemctl status libvirtd

# https://virt-manager.org
sudo apt-get install virt-manager
```

注销下用户，再进来 `virt-manager`,然后去下载镜像根据UI操作即可，默认不用调整什么（越改越烂，如果你不知道改的是什么意思）

显示驱动默认使用非 virtio，后面安装驱动后改用性能更好的这个

没有网络选择,去 编辑-连接详情-创建虚拟网络,自己常见一个NAT网络,注意不要和现有的网段冲突

# 下载安装驱动
https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers

# 启动virtio后，3D加速没法用

```
sudo apt-get install virgl-server
sudo apt-get install spice-vdagent
```
nvidia 显卡是真难

没解决问题

# 放弃 转战virtualbox


完全卸载quem和virt-manager

```  bash
sudo apt deb virtualbox-7.2_7.2.4-170995~Ubuntu~noble_amd64.deb
# 报错缺少依赖
sudo apt-get install -f

# 在终端执行以下命令，手动卸载冲突的模块
# 如果报错 "module is in use"： 说明有其他虚拟机软件（如 virt-manager, QEMU 或正在运行的 Docker 容器）正在使用 KVM。请先关闭它们，或者尝试使用以下命令强制停止相关服务后再卸载： sudo systemctl stop libvirtd
sudo modprobe -r kvm_amd
sudo modprobe -r kvm

```

## ...
捏马，显卡驱动还掉了，貌似禁用KVM导致

``` bash
# 尝试只移除核心模块（不触碰 ccp 等可能引起干扰的子模块）
sudo rmmod kvm_amd
```
