import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp, Button } from 'antd';
import zhCN from 'antd/es/locale/zh_CN.js';
import App from './App.js';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Do not expose configuration or request payloads in browser logs. */ }
  render() {
    return this.state.error ? <div className="fatal"><h1>页面暂时遇到问题</h1><p>已经提交的部署会继续执行。刷新页面查看最新状态。</p><Button type="primary" onClick={() => window.location.reload()}>刷新页面</Button></div> : this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ConfigProvider locale={zhCN} theme={{ token: {
    colorPrimary: '#2458e8', colorInfo: '#2458e8', colorText: '#17212f', colorTextSecondary: '#66758a',
    colorBorder: '#dfe4ec', colorBgLayout: '#f5f7fa', borderRadius: 5,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
    controlHeight: 36, fontSize: 13,
  }, components: { Button: { primaryShadow: 'none' }, Modal: { paddingContentHorizontalLG: 28, paddingContentVerticalLG: 26 }, Tabs: { horizontalItemGutter: 28 } } }}>
    <AntApp><ErrorBoundary><App /></ErrorBoundary></AntApp>
  </ConfigProvider></React.StrictMode>,
);
