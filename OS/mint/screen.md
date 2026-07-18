# 看下DPMS

关注DPMS

``` bash
xset q
```

# 设置关闭屏幕

``` bash 
# xset dpms [Standby] [Suspend] [Off]（单位：秒）
# xset 仅适用于 Xorg 环境，Wayland 下无效 (echo $XDG_SESSION_TYPE确认)
xset dpms 600 900 1200   # 10分钟无操作待机，15分钟挂起，20分钟关闭屏幕

# 三个状态核心区别（只记关键）
# Standby：黑屏、秒唤醒、轻度节能 → 主力使用
# Suspend：黑屏、微延迟唤醒、中度节能 → 过渡状态
# Off：黑屏、1-2 秒唤醒、极致节能 → 深度省电

# xset s [timeout] [cycle]
xset s 600 0

xset s on  # 启用屏幕节能
```

# 立刻黑屏

``` bash 
xset dpms force off
```

# 参考

``` 
xset -q
Keyboard Control:
  auto repeat:  on    key click percent:  0    LED mask:  00000002
  XKB indicators:
    00: Caps Lock:   off    01: Num Lock:    on     02: Scroll Lock: off
    03: Compose:     off    04: Kana:        off    05: Sleep:       off
    06: Suspend:     off    07: Mute:        off    08: Misc:        off
    09: Mail:        off    10: Charging:    off    11: Shift Lock:  off
    12: Group 2:     off    13: Mouse Keys:  off
  auto repeat delay:  500    repeat rate:  33
  auto repeating keys:  00ffffffdffffbbf
                        fadfffefffedffff
                        9fffffffffffffff
                        fff7ffffffffffff
  bell percent:  50    bell pitch:  400    bell duration:  100
Pointer Control:
  acceleration:  2/1    threshold:  4
Screen Saver:
  prefer blanking:  yes    allow exposures:  yes
  timeout:  600    cycle:  0
Colors:
  default colormap:  0x20    BlackPixel:  0x0    WhitePixel:  0xffffff
Font Path:
  /usr/share/fonts/X11/misc,/usr/share/fonts/X11/Type1,built-ins
DPMS (Display Power Management Signaling):
  Standby: 600    Suspend: 660    Off: 720
  DPMS is Enabled
  Monitor is On
```