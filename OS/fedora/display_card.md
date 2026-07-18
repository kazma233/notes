# 前提

关闭安全启动 Secure Boot

# 配置
在软件中心勾选上Nvidia的源，update源缓存后，就能看到Nvidia的驱动了，点击安装就好

# 无输出，成功

`lsmod | grep nouveau`

目测装驱动的时候，直接禁用了nouveau
