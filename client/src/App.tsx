import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "components/layout/AppLayout";
import { DisplayToasts } from "components/display_components";
import { useAuthStore } from "utils/store/authStore";
import { LoginScreen } from "screens/login_screen";
import { AppsScreen } from "screens/apps_screen";

export const App = () => {
  const token = useAuthStore((state) => state.token);

  return (
    <>
      {token ? (
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/apps" element={<AppsScreen />} />
            <Route path="*" element={<Navigate to="/apps" replace />} />
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
