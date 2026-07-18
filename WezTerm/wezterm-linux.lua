-- Pull in the wezterm API
local wezterm = require 'wezterm'

-- This will hold the configuration.
local config = wezterm.config_builder()

-- This is where you actually apply your config choices.

config.initial_cols = 120
config.initial_rows = 30

config.font = wezterm.font 'Fira Code'
config.font = wezterm.font_with_fallback {
  'JetBrains Mono',
}
config.font_size = 18
config.color_scheme = 'Vs Code Light+ (Gogh)'

# x11 deskptop env and use fcitx
config.front_end = "WebGpu"
config.use_ime = true

-- Finally, return the configuration to wezterm:
return config
