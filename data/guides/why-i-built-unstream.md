---
title: Why I built Unstream
description: The story behind Unstream - from indie musician earning $2,200 on Bandcamp to building a tool that helps fans support artists directly.
pillar: builder
published: 2026-03-28
draft: true
---

# Why I built Unstream

I'm Brandon, and I built Unstream. I want to tell you why, because the reason is the product.

## The musician side

I make music under the name [Kid Lightbulbs](https://kidlightbulbs.com). I'm not famous. I don't have a big social media following. I haven't performed live in years. By every metric the streaming industry cares about, I shouldn't be making any money from music.

And yet — I've earned over **$2,200 on Bandcamp** in the past couple of years.

That number might not sound like much, but for an independent musician with a small audience, it's extraordinary. It happened because I put my music on a platform where people could actually *buy* it, and a small group of fans did exactly that. No playlist gatekeepers, no algorithmic favor, no label deal. Just music and people who wanted to own it.

That experience fundamentally changed how I think about the music industry. It convinced me that the streaming model — where artists earn fractions of a penny per play and have no real relationship with their listeners — isn't the only path. There are alternatives, and they work.

## The listener side

At the same time, I'd been paying for Apple Music for over a decade. And I'd been wanting to cancel.

Not because the service was bad — it's incredibly convenient. But I wanted to own my music again. I wanted to rediscover the experience of finding something new, buying it, and having it be *mine*. I wanted to give less money to Apple and more money to the artists whose work I actually love.

When I started exploring this, I was surprised by what I found. So many of my favorite artists were already selling on Bandcamp. Many were on platforms I'd never heard of — Mirlo, Ampwall, Faircamp. Some had Ko-fi pages or Patreon memberships. The infrastructure for supporting artists directly was already there. The problem was finding it.

## The discovery problem

That was the gap. The platforms existed. The artists were on them. But as a listener, there was no easy way to search across all of them at once. If I wanted to know whether a particular artist sold on Bandcamp *and* had a Mirlo page *and* accepted tips on Ko-fi, I'd have to check each platform individually. Multiply that across every artist I listen to, and it becomes overwhelming.

So I built a tool to do it for me. And then I thought: other people probably want this too.

## What Unstream does

[Unstream](https://unstream.stream) searches **23+ alternative music platforms** simultaneously. Type in an artist name and it shows you everywhere they sell, stream, or accept support — from Bandcamp and Mirlo to Ko-fi and Patreon to library services like Hoopla.

For each platform, Unstream shows the **approximate percentage of a sale that goes to the artist**. So you're not just finding where to buy — you're making an informed choice about where your money has the most impact.

## Design principles

A few things I cared about from the start:

**Free, always.** Unstream is free because the entire point is getting money to artists, not charging you to find them. Adding a paywall would defeat the purpose.

**No tracking.** We collect virtually no data. No accounts required, no cookies for advertising, no selling your listening habits. Your music taste is your business.

**Open source.** The entire codebase is [on GitHub](https://github.com/brandonlucasgreen/unstream). Anyone can see how it works, suggest improvements, or contribute. Transparency matters when you're asking people to trust a tool with their music discovery.

**Not anti-streaming — pro-alternatives.** I'm not here to shame anyone for using Spotify. Streaming is convenient and sometimes it's the right tool. But I believe people should know that alternatives exist, and that those alternatives pay artists dramatically better. Unstream just makes them easier to find.

## What's been built so far

What started as a simple search tool has grown into something bigger:

- A **browser extension** for Chrome and Firefox that detects what you're listening to on Spotify, YouTube Music, and other platforms and shows you where to support that artist directly
- A **macOS menu bar app** that detects currently playing music and surfaces support options in real-time
- **Artist profiles** where musicians can claim their page, verify their identity, customize their presence, and track how fans are finding them
- **Daily artist spotlights** shared across social media to help listeners discover independent artists on these platforms

## What's next

Unstream is one person's project, built in nights and weekends, driven by the conviction that the way we pay for music can be better. The community around it is growing — more artists claiming profiles, more listeners discovering alternatives, more platforms joining the ecosystem.

If you're a musician, consider [claiming your artist profile](https://unstream.stream/artist-login) on Unstream. If you're a listener, try searching for an artist you love. You might be surprised where you find them — and how much more of your money can reach them.
