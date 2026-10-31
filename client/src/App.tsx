import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "components/layout/AppLayout";
import { DisplayToasts } from "components/display_components";
import { useAuthStore } from "utils/store/authStore";
import { LoginScreen } from "screens/login_screen";
import { AppsScreen } from "screens/apps_screen";
import { RunsScreen } from "screens/runs_screen";
import { RunReplayScreen } from "screens/run_replay_screen";
import { ForkCompareScreen } from "screens/fork_compare_screen";

export const App = () => {
  const token = useAuthStore((state) => state.token);

  return (
    <>
      {token ? (
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/runs" element={<RunsScreen />} />
            <Route path="/runs/:id" element={<RunReplayScreen />} />
            <Route path="/runs/:id/compare" element={<ForkCompareScreen />} />
            <Route path="/apps" element={<AppsScreen />} />
            <Route path="*" element={<Navigate to="/runs" replace />} />
          </Route>
        </Routes>
      ) : (
        <Routes>
          <Route path="*" element={<LoginScreen />} />
        </Routes>
      )}
      <DisplayToasts />
    </>
  );
};
