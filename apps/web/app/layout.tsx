import type { ReactNode } from 'react';
import './globals.css';
export const metadata = { title: 'Claro Copiloto', description: 'Consola de atención asistida' };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="es"><body>{children}</body></html>; }
