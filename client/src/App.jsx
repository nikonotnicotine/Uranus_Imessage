/*
 * 登录门 + 两层 Provider 套壳，界面全在 shell.jsx。
 *
 * AuthGate 在 Provider **外面**：没登录的时候连 /api/config 都不该去拉
 * （那一条会被 401 挡掉，ConfigProvider 会把它当成「配置读不出来」，
 * 在登录页背后留一屏「无法加载配置」的错误态）。
 */

import { AuthGate } from "./panels/auth.jsx";
import { AppShell } from "./shell.jsx";
import { ConfigProvider, LogProvider } from "./store.jsx";

export default function App() {
  return (
    <AuthGate>
      <ConfigProvider>
        <LogProvider>
          <AppShell />
        </LogProvider>
      </ConfigProvider>
    </AuthGate>
  );
}
