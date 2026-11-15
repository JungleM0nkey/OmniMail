// The shared mailbox is a separate Astryx page with its own stylesheet, so it
// loads without the main app's global CSS and the main app without Astryx's.
if (/^\/shared(\/|$)/.test(window.location.pathname)) void import('./features/shared-mailbox/main')
else void import('./app/main')
