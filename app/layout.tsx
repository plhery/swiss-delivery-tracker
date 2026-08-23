import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../src/styles.css';

export const metadata: Metadata = {
  applicationName: 'Swiss Delivery Tracker',
  title: 'Swiss Delivery Tracker',
  description: 'Follow your Swiss package deliveries through every stage.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/icons/icon.svg',
    apple: '/icons/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Deliveries',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffcf00',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
