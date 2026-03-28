---
title: Why I built Unstream
description: The story behind Unstream - from indie musician earning $2,200 on Bandcamp to building a tool that helps fans support artists directly.
pillar: builder
published: 2026-03-28
draft: true
---

# Why I built Unstream

I make music under the name [Kid Lightbulbs](https://kidlightbulbs.com). I'm not famous. I haven't performed live in years. By every metric the streaming industry cares about, I shouldn't be making money from music.

But I've earned over **$2,200 on Bandcamp** in the past couple of years. From a small group of people who wanted to buy my music and own it. No playlist gatekeepers, no algorithmic favor. Just music and people.

That kind of broke my brain. It made the whole streaming model — fractions of a penny per play, no relationship with listeners, everything mediated by an algorithm — feel like a choice rather than an inevitability. There are other ways to do this, and they actually work.

## The other side

At the same time, I'd been paying for Apple Music for over a decade and wanting to cancel. Not because it's bad — it's incredibly convenient. But I missed *owning* things. I wanted to find something new, buy it, and have it be mine. I wanted more of my money going to artists and less to Apple.

I'd also been getting increasingly uncomfortable with the economics. I knew the per-stream payout numbers were bad, but when I did the math on my own listening — how many times I'd played certain albums, what those artists actually earned from my subscription — it felt pretty gross. I was paying $10.99 a month and the artists I cared about most were seeing pennies.

When I started looking around for alternatives, I was surprised by how much was already out there. So many artists I like were selling on Bandcamp. A bunch were on platforms I'd never heard of — Mirlo, Ampwall, Faircamp. Some had Ko-fi pages or Patreon memberships. The whole infrastructure for supporting artists directly was already there.

The problem was just finding it all.

## So I built the thing

If I wanted to know whether a particular artist sold on Bandcamp *and* had a Mirlo page *and* accepted tips on Ko-fi, I'd have to check each platform one by one. Multiply that by every artist I listen to and it's a real pain.

So I built a tool to do it over a holiday break. [Unstream](https://unstream.stream) searches 23+ alternative music platforms at once. Type in an artist name and it shows you everywhere they sell, stream, or accept support — with the approximate percentage that goes to the artist on each one. So you're not just finding where to buy, you're making an informed choice about where your money has the most impact.

The name is a verb. *Unstream* your music — move it off the rental platforms and into something you own, on platforms where artists keep 80–97% instead of fractions of a penny.

## How I think about it

A few things I cared about from the start:

**Free, always.** The entire point is getting money to artists. Charging you to find them would defeat the purpose. Unstream is donation-supported — you can chip in if you want to keep the lights on, but you never have to.

**No tracking.** No accounts required to search (artists can optionally create accounts to claim their profiles). No advertising cookies. No selling your listening habits. Your music taste is your business.

**Open source.** The whole codebase is [on GitHub](https://github.com/brandonlucasgreen/unstream). Anyone can see how it works, suggest improvements, or contribute. If I disappeared tomorrow the code would still be there.

**Not anti-streaming.** I'm not here to shame anyone for using Spotify. I still use it sometimes. But I think people should know alternatives exist, and that those alternatives pay artists dramatically better. Unstream just makes them easier to find.

## What it's turned into

What started as a simple search page has grown more than I expected:

- A **browser extension** for Chrome and Firefox that detects what you're listening to on Spotify or YouTube Music and shows you where to support that artist directly — a little popup that says "hey, this artist is on Bandcamp and Mirlo too"
- A **macOS menu bar app** that does the same thing with whatever's currently playing on your computer, sitting quietly in your menu bar until you want it
- **Artist profiles** where musicians can claim their page on Unstream, verify their identity through their website, customize their presence, and see how fans are finding them — sort of a Linktree for artist-friendly platforms
- **Transparent payout info** on every search result, so you can see at a glance which platform gives the most to the artist

It's one person's project, built in nights and weekends, driven by the experience of being both an artist who benefits from direct sales and a fan who wants to put more money in artists' pockets. If you're a musician, you can [claim your artist page](https://unstream.stream/artist-login). If you're a listener, try searching for someone you love. You might be surprised where you find them.
