// The site's name, shown as the wordmark and in the browser tab. Set VITE_APP_NAME in .env. In
// production the server writes it into the page as it starts; in development Vite supplies it.
const served = document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content;
export const APP_NAME: string = served?.trim() || import.meta.env.VITE_APP_NAME?.trim() || "Parley";
