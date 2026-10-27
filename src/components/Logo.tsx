import logoUrl from "../assets/stream-vehicle-logo.svg";

export const APP_NAME = "Stream Vehicle";

/** The app logo (symbol and name), signal green on the always-dark header plate. */
export function AppLogo() {
  return <img src={logoUrl} alt={APP_NAME} width={205} height={24} />;
}
