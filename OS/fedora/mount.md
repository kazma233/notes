# 临时挂载
```
lsblk -f

# 不用指定 -t ntfs-3g，直接挂载
sudo mount /dev/sda1 /mnt/data

# 或显式指定内核驱动
sudo mount -t ntfs /dev/sda1 /mnt/data

sudo chown $USER:$USER /mnt/data
```

# 长期挂载
为什么设 1000？
1000 是 Linux 第一个普通用户的默认 UID
单用户系统通常就是 1000
多用户系统可能是 1001, 1002...
可以使用`id`看你当前uid

## ntfs

``` sh
sudo vim /etc/fstab

# 写入
# UUID=7CCAABDC69CE333F  /mnt/data  ntfs  defaults,uid=1000,gid=1000,umask=002  0  0

#UUID=xxx  /mnt/data  ntfs  defaults,uid=1000  0  0
#│         │          │     │                  │  │
#│         │          │     │                  │  └── 第6列：fsck检查顺序；0-Linux 的 fsck 不懂 NTFS，检查交给 Windows 或 ntfsfix
#│         │          │     │                  └───── 第5列：dump备份标记；0-不dump备份，用 rsync/tar 等工具备份
#│         │          │     └──────────────────────── 挂载选项
#│         │          └────────────────────────────── 文件系统类型
#│         └───────────────────────────────────────── 挂载点
#└─────────────────────────────────────────────────── 设备标识

sudo mount -a
systemctl daemon-reload
```
umask=002
→ 目录权限：775（可读可写可进入）
→ 文件权限：664（可读可写）


## exFAT

``` sh
sudo mkdir -p /mnt/STORE
sudo vim /etc/fstab

# 写入
# UUID=6DE3-E5F7 /mnt/STORE exfat defaults,uid=1000,gid=1000,umask=000 0 0

sudo mount -a
```
umask=000
→ 目录权限：777（所有人可读可写可进入）
→ 文件权限：666（所有人可读可写）
你这是自己用的仓库盘，不是服务器公网盘，完全没问题。

fsck
开机磁盘检查顺序
0 = 不检查/ 开机 fsck 检查不识别 exFAT，会报错、甚至卡住开机
1 = 根文件系统优先
2 = 普通数据盘
