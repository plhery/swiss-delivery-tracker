import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import { ClientApplication } from '../src/ClientApplication';

const title = 'French & Swiss Parcel Tracking | Swiss Delivery Tracker';
const description =
  'Private parcel tracking across France and Switzerland for French, Swiss, and international carriers.';

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first && first.length <= 253 ? first : null;
}

async function requestOrigin(): Promise<URL> {
  const requestHeaders = await headers();
  const host = firstHeaderValue(requestHeaders.get('host'))
    ?? firstHeaderValue(requestHeaders.get('x-forwarded-host'))
    ?? 'localhost';
  const forwardedProtocol = firstHeaderValue(requestHeaders.get('x-forwarded-proto'));
  const localHost = host === 'localhost'
    || host.startsWith('localhost:')
    || host === '[::1]'
    || host.startsWith('[::1]:')
    || host === '127.0.0.1'
    || host.startsWith('127.0.0.1:');
  const protocol = forwardedProtocol === 'http' || forwardedProtocol === 'https'
    ? forwardedProtocol
    : localHost ? 'http' : 'https';
  try {
    const origin = new URL(`${protocol}://${host}`);
    if (
      origin.username
      || origin.password
      || origin.pathname !== '/'
      || origin.search
      || origin.hash
    ) return new URL('http://localhost');
    return new URL(origin.origin);
  } catch {
    return new URL('http://localhost');
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const origin = await requestOrigin();
  const image = new URL('/og.png', origin).href;
  return {
    metadataBase: origin,
    title,
    description,
    alternates: { canonical: origin.href },
    openGraph: {
      type: 'website',
      url: origin.href,
      siteName: 'Swiss Delivery Tracker',
      title,
      description,
      images: [{
        url: image,
        width: 1_734,
        height: 907,
        alt: 'Swiss Delivery Tracker for parcel deliveries across France and Switzerland',
      }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  };
}

export default async function HomePage() {
  await connection();
  return <ClientApplication />;
}
