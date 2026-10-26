#!/bin/zsh
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/cn.local.launchpad.plist" 2>/dev/null || true
launchctl kickstart gui/$(id -u)/cn.local.launchpad
open http://localhost:3201
