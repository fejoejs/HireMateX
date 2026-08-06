export const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL || 'https://hirematex-api-97nu.onrender.com'
).replace(/\/+$/, '');

export const WEB_URL = (
  process.env.NEXT_PUBLIC_WEB_URL || 'https://hirematex.vercel.app'
).replace(/\/+$/, '');
