'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { GitHubStarsLink } from '@/components/github-stars'

const navigationItems = [
  { label: 'Product', href: '/' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Download', href: '/download' },
]

function isNavigationItemActive(pathname: string, href: string) {
  if (href === '/') {
    return pathname === '/'
  }

  return pathname === href || pathname.startsWith(`${href}/`)
}

export function SiteHeader() {
  const pathname = usePathname()

  return (
    <header className="landing-reveal landing-reveal-header fixed inset-x-0 top-0 z-30 bg-gradient-to-b from-[#050505]/90 via-[#050505]/45 to-transparent">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
        <Link
          href="/#top"
          className="group flex items-center gap-3 rounded-full focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-[#050505]"
          aria-label="Blame home"
        >
          <span className="grid h-10 w-10 place-items-center">
            <Image
              src="/icons/blame-icon-256.png"
              alt=""
              width={40}
              height={40}
              className="h-10 w-10 object-contain"
              priority
            />
          </span>
          <span className="font-display inline-block text-2xl text-white">
            Blame
          </span>
        </Link>

        <nav
          aria-label="Main navigation"
          className="hidden items-center gap-1 rounded-full border border-white/10 bg-[#070a15]/35 p-1 text-sm text-white/70 shadow-2xl shadow-black/20 backdrop-blur-xl md:flex"
        >
          {navigationItems.map((item) => {
            const isActive = isNavigationItemActive(pathname, item.href)

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={
                  isActive
                    ? 'rounded-full bg-white text-[#070a15] px-4 py-2 shadow-lg shadow-white/10 transition duration-200 hover:bg-white hover:text-[#070a15] focus:outline-none focus:ring-2 focus:ring-white/40'
                    : 'rounded-full px-4 py-2 transition duration-200 hover:bg-white/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40'
                }
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        <GitHubStarsLink />
      </div>
    </header>
  )
}
