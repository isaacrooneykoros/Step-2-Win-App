import { AdminLayout } from './AdminLayout'

/**
 * Legacy name for the app shell. Kept so old imports keep working;
 * renders the same AdminLayout (sidebar, top bar, outlet).
 */
export function Layout() {
  return <AdminLayout />
}
