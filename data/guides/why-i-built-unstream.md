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

When I started looking around, I was surprised. So many artists I like were already selling on Bandcamp. A bunch were on platforms I'd never heard of — Mirlo, Ampwall, Faircamp. Some had Ko-fi pages or Patreon memberships. The whole infrastructure for supporting artists directly was already there.

The problem was just finding it all.

## So I built the thing

If I wanted to know whether a particular artist sold on Bandcamp *and* had a Mirlo page *and* accepted tips on Ko-fi, I'd have to check each platform one by one. Multiply that by every artist I listen to and it's a pain.

So I built a tool to do it. [Unstream](https://unstream.stream) searches 23+ alternative music platforms at once. Type in an artist name and it shows you everywhere they sell, stream, or accept support — with the approximate percentage that goes to the artist on each one.

## How I think about it

A few things I cared about from the start:

**Free, always.** The entire point is getting money to artists. Charging you to find them would defeat the purpose.

**No tracking.** No accounts required, no advertising cookies, no selling your listening habits.

**Open source.** The whole codebase is [on GitHub](https://github.com/brandonlucasgreen/unstream). Anyone can see how it works or contribute.

**Not anti-streaming.** I'm not here to shame anyone for using Spotify. But I think people should know alternatives exist, and that those alternatives pay artists dramatically better. Unstream just makes them easier to find.

## What it's turned into

What started as a search tool has grown a bit:

- A **browser extension** for Chrome and Firefox that detects what you're listening to on Spotify or YouTube Music and shows you where to support that artist directly
- A **macOS menu bar app** that does the same thing with whatever's currently playing
- **Artist profiles** where musicians can claim their page, verify their identity, and see how fans are finding them

It's one person's project, built in nights and weekends. If you're a musician, you can [claim your artist page](https://unstream.stream/artist-login). If you're a listener, try searching for someone you love. You might be surprised where you find them.
