# 配置
新增`/etc/systemd/system/rclone-onedrive.service`文件，配置如下
```
[Unit]
Description=Rclone Mount OneDrive to NTFS Disk
After=network.target network-online.target local-fs.target
Wants=network-online.target
RequiresMountsFor=/mnt/STORE

[Service]
User=%i
Group=%i
Type=notify
ExecStartPre=/usr/bin/fusermount -u /mnt/STORE/OneDrive 2>/dev/null
ExecStart=/usr/bin/rclone mount remote:/ /mnt/STORE/OneDrive \
  --allow-other \
  --allow-non-empty \
  --vfs-cache-mode full \
  --buffer-size 64M \
  --transfers 8 \
  --vfs-cache-max-size 20G \
  --vfs-cache-max-age 24h \
  --vfs-read-ahead 128M \
  --cache-dir /mnt/STORE/rclone-cache \
  --log-level INFO \
  --log-file /mnt/STORE/rclone-logs/rclone-mount.log \
  --dir-cache-time 60m \
  --vfs-fast-fingerprint \
  --poll-interval 30s
ExecStop=/usr/bin/fusermount -u /mnt/STORE/OneDrive
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

如果是挂载磁盘，推荐磁盘格式exFAT，并且先提前挂载好，目录也先创建好
``` sh
mkdir -p /mnt/STORE/OneDrive
mkdir -p /mnt/STORE/rclone-cache
```

```
--allow-other
允许非挂载用户访问挂载目录（比如你用普通用户挂载，其他用户 / 程序也能读 /mnt/STORE/OneDrive）。
官方说明：默认仅挂载用户可访问，需配合 fuse 的 allow_other 权限（Linux 下需确保 /etc/fuse.conf 中 user_allow_other 已开启）。

--allow-non-empty
允许挂载到非空目录（比如 /mnt/STORE/OneDrive 里已有文件，仍能正常挂载）。
官方说明：默认 rclone 禁止挂载到非空目录，防止覆盖数据；仅在确认目录内文件无冲突时使用。

--daemon
作用：让 rclone mount 后台运行（守护进程模式），关闭终端后挂载不会中断。

--vfs-read-ahead
预读取128M数据，视频拖拽更流畅

--cache-dir /mnt/STORE/rclone-cache 
把缓存放到NTFS硬盘，不占系统盘

--dir-cache-time 60m
目录缓存 60 分钟，不用反复查云端

--poll-interval 30s
设置 rclone 主动检查云端（OneDrive）文件变化的间隔时间，单位支持 s/m/h（比如 5m=5 分钟）。

--vfs-fast-fingerprint
跳过对文件「完整指纹校验」，改用「轻量校验」获取文件的大小、修改时间、权限等元数据（文件管理器刷目录时最依赖这些信息）。
```

# 自己测试

## 启动
``` sh
rclone mount remote:/ /mnt/STORE/OneDrive \
  --allow-other \
  --allow-non-empty \
  --vfs-cache-mode full \
  --vfs-cache-max-size 20G \
  --vfs-cache-max-age 24h \
  --vfs-read-ahead 128M \
  --vfs-fast-fingerprint \
  --transfers 8 \
  --cache-dir /mnt/STORE/rclone-cache \
  --log-level INFO \
  --log-file /mnt/STORE/rclone-logs/rclone-mount.log \
  --daemon
```

## 优雅停止
``` sh
# 1. 先正常卸载 FUSE 挂载点（核心：触发 rclone 清理缓存）
fusermount -u /mnt/STORE/OneDrive

# 2. 验证挂载点已卸载（无输出则成功）
df -h | grep OneDrive

# 3. （可选）确认 rclone 进程已退出（无 rclone 进程则无需下一步）
ps aux | grep rclone | grep -v grep

# 4. 若进程仍存在，优雅杀死（用 SIGTERM 信号，而非 SIGKILL）
kill -15 $(pgrep rclone)
```

### 卸载报错：fusermount: failed to unmount /mnt/STORE/OneDrive: Device or resource busy
``` sh
fuser -v /mnt/STORE/OneDrive

#kazma@fedora:~$ fuser -v /mnt/STORE/OneDrive
#                     用户     进程号 权限   命令
#/mnt/STORE/OneDrive: root     kernel mount /mnt/STORE/OneDrive
```

你看到 fuser 输出里显示 root kernel mount，这说明挂载点被 Linux 内核直接占用（不是普通进程），是 rclone 挂载异常后的典型状态 —— 内核认为该目录还在「挂载中」，但实际管理挂载的 rclone 进程可能已异常退出，导致普通卸载命令失效。

root kernel mount：不是某个具体的用户进程（比如 bash、播放器），而是内核的 FUSE 模块标记该目录为「已挂载状态」，且没有用户态进程（rclone）来管理这个挂载；

这种情况普通的 fusermount -u 或 kill 进程都没用，必须用内核级的「懒卸载」来清理。

``` sh
# 核心：懒卸载内核占用的挂载点（最安全的方式）
sudo umount -l /mnt/STORE/OneDrive

# 验证卸载是否成功（无输出=成功）
df -h | grep OneDrive

# 清理残留的 FUSE 状态（避免后续挂载报错）
fusermount -u /mnt/STORE/OneDrive 2>/dev/null || true
```

# 服务的方式启动
## 启动服务
``` sh
# 刷新系统服务配置
sudo systemctl daemon-reload

# 设置开机自启
sudo systemctl enable rclone-onedrive@$USER

# 立即启动服务（不用重启系统）
sudo systemctl start rclone-onedrive@$USER

# 查看服务状态（确认无报错，显示 active (running) 就是成功）
sudo systemctl status rclone-onedrive@$USER
```

## 停止服务
``` sh
# 1. 优雅停止服务（自动执行 ExecStop 里的卸载命令 + 清理进程）
sudo systemctl stop rclone-onedrive@$USER

# 2. 验证服务状态（显示 inactive (dead) 则成功）
sudo systemctl status rclone-onedrive@$USER

# 3. （可选）禁止开机自启（如需彻底停用）
sudo systemctl disable rclone-onedrive@$USER
```

# `Transport endpoint is not connected`问题
``` sh
# 强制卸载异常的 OneDrive 挂载点
sudo umount -l /mnt/STORE/OneDrive

# 重置 FUSE 挂载状态（解决 Transport endpoint 问题）
fusermount -u /mnt/STORE/OneDrive 2>/dev/null || true

# 重新挂载 NTFS 硬盘（确保基础目录可用）
sudo mount -a

# 检查硬盘是否正常挂载
df -h | grep STORE
```

核心原因（按触发概率排序）
1. 最常见：rclone 进程异常退出（未正常卸载）
这是你这个场景的主要原因：
你之前手动执行过 rclone mount 但没加 --daemon，关闭终端时 rclone 进程被强制杀死；
或挂载过程中网络断开、OneDrive 授权超时，导致 rclone 进程崩溃；
结果：内核的 FUSE 模块还记录着 /mnt/STORE/OneDrive 是「已挂载状态」，但实际没有进程管理这个挂载点，形成「僵死挂载」，后续再挂载就会提示 Transport endpoint is not connected。
2. 次常见：NTFS 硬盘挂载不稳定（基础目录异常）
你的 OneDrive 挂载点 /mnt/STORE/OneDrive 依赖 NTFS 硬盘的 /mnt/STORE：
NTFS 硬盘由 ntfs-3g 驱动管理，若硬盘休眠、IO 错误、断电，会导致 /mnt/STORE 目录「看似挂载但实际不可用」；
子目录 /mnt/STORE/OneDrive 依赖父目录的正常状态，父目录异常会直接触发传输端点连接失败。
3. 小众原因：FUSE 模块 / 系统资源问题
Linux 的 FUSE 内核模块（rclone 挂载依赖）本身出现小故障，比如缓存溢出、进程锁未释放；
系统文件句柄耗尽（比如同时挂载多个网盘 / 硬盘），导致新的挂载请求无法创建传输端点。
4. 配置层面：新增参数未提前创建目录
你这次加了 --cache-dir /mnt/STORE/rclone-cache，但如果没提前创建这个目录，也会间接导致挂载进程异常退出，进而触发僵死挂载。


# 总结
- 通过 fstab 配置，你的 NTFS 硬盘 /dev/sda1 会在开机时自动挂载到 /mnt/STORE，且权限为当前用户可读写；
- 通过 systemd 服务，OneDrive 会在硬盘挂载完成、网络就绪后，自动挂载到 /mnt/STORE/OneDrive，缓存优化适配视频 / 相册播放；
- 核心保障：RequiresMountsFor=/mnt/STORE 确保只有硬盘挂载成功后，OneDrive 才会挂载，避免挂载失败。
