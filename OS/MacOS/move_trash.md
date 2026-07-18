# 递归清除应用的隔离标记，把应用拖进终端补全路径
sudo xattr -rd com.apple.quarantine /Applications/目标应用.app
