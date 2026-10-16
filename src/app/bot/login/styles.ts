/**
 * The sign-in screen: one card centred on the page. A plain module, so the
 * server page and the client setup check both get the strings; a constant
 * exported from a "use client" file reaches a server component as a client
 * reference instead, and its classes silently vanish.
 */
export const LOGIN = "grid min-h-dvh place-items-center px-4 py-6";
export const LOGIN_CARD = "w-full gap-3 rounded-[14px] p-[22px] text-[13px] ring-input";
