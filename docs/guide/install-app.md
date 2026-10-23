# Install Sidekick as an app

You can install the Sidekick portal as an app on your computer or phone. It then opens in its own window with the Sidekick icon, from your dock, taskbar, Start menu or home screen, instead of in a browser tab. It's the same portal: same sign-in, same data, same pages.

## On a computer (Chrome or Microsoft Edge)
1. Open the portal and sign in.
2. Either go to **Help & support** and press **Install** in the "Install Sidekick as an app" box, or click the install icon at the right end of the address bar (a small screen with an arrow).
3. Confirm with **Install**.

Sidekick opens in its own window and appears with your other apps. To remove it, open the app, click the **⋮** menu in its title bar and choose **Uninstall Sidekick**.

Safari on a Mac: **File → Add to Dock**. Firefox doesn't install websites as apps; use a bookmark instead.

## On an iPhone or iPad
1. Open the portal in **Safari** and sign in.
2. Tap **Share** (the square with an arrow), then **Add to Home Screen**, then **Add**.

The Sidekick icon on your home screen opens the portal full screen, like an app. To remove it, touch and hold the icon and choose **Remove App**.

## On an Android phone
1. Open the portal in **Chrome** and sign in.
2. Tap **⋮**, then **Install app** (or **Add to Home screen**), then **Install**.

## Good to know
- **Nothing extra is stored on your device.** The app doesn't keep copies of your pages, documents or answers for offline use; everything comes from Sidekick each time, exactly as in a browser tab, so one organization's or group's information never lingers on a shared device. Without a connection you'll see your browser's "no connection" page.
- **Signing in works the same**, including Microsoft sign-in, passkeys and two-step sign-in. On a computer or Android phone the app shares sign-in with the browser it came from; an iPhone home-screen app (and Safari's Add to Dock on a Mac) keeps its own, so you sign in once inside it.
- **The hint is quiet.** The "Install Sidekick as an app" box on Help & support only appears where your browser can install apps, and **Not now** hides it for good in that browser. It never shows inside the installed app.
- **Only the portal installs.** The public website and the help center open inside the app window if you follow a link to them, but the browser won't offer to install them on their own.
<!-- help-center:skip -->

## For developers
- Manifest: `app/src/app/manifest.ts` (served at `/manifest.webmanifest`); names from `lib/brand.ts`, start page, scope, colors and the reasons for "no service worker" in `lib/pwa.ts`.
- Which pages offer install: the root layout links the manifest; `app/(public)/layout.tsx` and `app/owner/layout.tsx` remove it (`NOT_INSTALLABLE`); portal and sign-in layouts add the iPhone tags (`INSTALLABLE`).
- Icons: `app/public/app-icons/`, drawn by `app/scripts/app-icons.mjs` (re-run after a rename or color change; usage in its header).
- The hint: `app/src/components/install-app.tsx`. Tests: "installable app" in `app/tests/api.test.mjs`.
<!-- /help-center:skip -->
