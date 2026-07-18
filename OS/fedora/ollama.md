``` sh
sudo systemctl edit ollama.service
```

完整流程(nano)：
- 编辑内容（添加环境变量等）
- 按 Ctrl + O → 看到文件名 → 按 Enter
- 按 Ctrl + X 退出

``` ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_ORIGINS=*"
```

``` sh
sudo dnf install xorg-x11-drv-nvidia-cuda
modinfo -F version nvidia #检查内核模块是否已构建。

# 重新加载配置
sudo systemctl daemon-reload

# 重启 Ollama
sudo systemctl restart ollama

# 验证状态
sudo systemctl status ollama
```
