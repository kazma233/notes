# 输入法

1. IBus + RIME（升级系统后消失了）
2. Fcitx5 + RIME (在用)

## AI总结
|特性	|IBus (Intelligent Input Bus)	|Fcitx5 (Flexible Input Method Framework)
|---|---|---
|核心定位|GNOME 默认、多语言优先、D-Bus 总线架构|跨桌面轻量高效、模块化强、Wayland 优化
|架构|C+Python，基于 D-Bus，进程间通信多|C++ 现代模块化，直接 IPC，插件化设计
|性能|响应稍慢、内存占用略高|启动快、更轻量、输入延迟低
|Wayland 支持|良好（GNOME 下最佳）|出色（KDE / 跨桌面更优）
|定制化|基础配置，主题 / 插件有限|高度可定制，主题 / 插件 / 行为丰富
|生态|ibus-pinyin/libpinyin/rime 等，搜狗早期适配|fcitx5-chinese-addons、rime、云拼音、剪贴板管理等
|发行版默认|Ubuntu、Fedora 等 GNOME 系默认|KDE 系默认，Linux Mint 等可选
|授权|GPLv2+|LGPLv2.1+（Fcitx5）
