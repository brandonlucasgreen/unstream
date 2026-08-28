export interface FAQSection {
  title: string;
  content: string;
}

export const faqSections: FAQSection[] = [
  {
    title: "Why did you build this?",
    content: `A few reasons! First, [I am a musician](https://kidlightbulbs.com) who's grown disenchanted by the streaming ecosystem, and I ended up finding much more success building an audience on my own on Bandcamp. I ended up making over $2200 in two years, despite a tiny following online & having not performed live during that period at all. I've now seen the success of pursuing this path as an independent musician, and I want to encourage fellow artists explore these alternative platforms as homes for their music.

As a consumer, I've paid for streaming services for over a decade, mostly Apple Music. But I've wanted to cancel it and build my own library of owned music – to rediscover the joy of finding new music myself, to give Apple less of my money, and to give more of that money to the artists whose music I love. In exploring this, I learned _just how many_ of my favorite artists post & sell their music on Bandcamp, as well as other platforms I learned about on my journey.

I built Unstream to serve both of these purposes: help fellow listeners find better ways to support the artists they love more easily, build their own libraries, and ultimately reduce their dependency on streaming, while also encouraging fellow artists to trust & use these alternative models rather than relying on streaming as a conduit to success.`
  },
  {
    title: "What's the problem with streaming? Why are the platforms Unstream recommends better than Spotify / Apple Music / my streaming app of choice?",
    content: `Well, for one, the owners of these platforms don't [actively invest in militarization efforts](https://faroutmagazine.co.uk/spotify-ceo-daniel-ek-chairman-ai-military-million-investment/) 😅

But Spotify and its former CEO are not the only problems with the streaming model for music. Streaming is a consumer-friendly service offering access to almost the entire history of recorded music in a convenient subscription, but a tiny fraction of your subscription actually goes to the artists who make the music – and you have no control over _which_ artists they go to.

The exceptions are artists with hundreds of thousands of monthly listeners or more; while many are rightfully deserving of those listeners, the economics of streaming (especially on Spotify) disproportionately benefit those artists thanks to the outsized influence of the 3 major record labels. Smaller artists are effectively shut out from making money in the streaming ecosystem, and increasingly shut out of promotional opportunities to even grow their audience in this ecosystem as well thanks to an increased focus on AI and algorithms. What's more: streaming platforms, and the incentives they run on, are being flooded with AI-generated music, often created solely for the purposes of exploiting streaming algorithms and capturing more listeners (and thus revenue).

The platforms suggested by Unstream primarily focus on a _direct-support_ model, meaning you pay to _own_ an artist's music (or support them with a monthly subscription) and the majority of your payment goes to the rights holder of the music – which in many cases is the artist themselves.

We also link to a number of alternative services that can help you reduce your dependency on streaming, such as _more artist-friendly_ streaming/downloading platforms (like Qobuz) or renting music through your local library (via the services Hoopla and Freegal).`
  },
  {
    title: "How much money does the artist get when I buy their music?",
    content: `- Faircamp sites: varies, based on the artist's preferred payment method (typically ~90-97% of sale price)
- **Subvert:** **97%** of sale price [(source)](https://www.subvert.fm/docs/faq)
- **Ampwall:** **92-95%** of sale price [(source)](https://ampwall.com/selling)
- **Mirlo:** **86-90%** of sale price [(source)](https://mirlo.space/pages/about)
- **Bandcamp:** **80-85%** of sale price [(source)](https://bandcamp.com/fair_trade_music_policy)
- **Jam.coop:** **82-85%** of sale price — a 15% fee with a 20p minimum, so cheaper releases pay out a little less [(source)](https://jam.coop/docs/about)
- **Qobuz:** **70%** of sale price [(source)](https://www.reddit.com/r/audiophile/comments/esy440/comment/ffcxlql/)
- **Patreon:** **86-90%** of sales or memberships [(source)](https://support.patreon.com/hc/en-us/articles/11111747095181-Creator-fees-overview)
- **Buy Me a Coffee:** **92%** of sales or memberships [(source)](https://help.buymeacoffee.com/en/articles/8105744-how-to-calculate-charges-on-your-payment)
- **Ko-fi:** **97%** of tips / **92%** of sales [(source)](https://help.ko-fi.com/en/articles/360002506494-Does-Ko-fi-take-a-fee)

*More info:* All online transactions involving a credit card transaction incur credit card fees, which are typically ~2.9% of the purchase price, plus an additional 30 cents. This is always applied on top of a platform's fee, which is why the above percentage values vary a bit.`
  },
  {
    title: "What are some of the other benefits of moving off a streaming service?",
    content: `Lots of them!
- Save money
- Curate your own music library and tastes
- Discover new music through the recommendations of friends & tastemakers rather than an algorithm designed to keep you paying
- Support the artists you actually like, rather than the ones signed to the 3 major record labels
- Support your local library`
  },
  {
    title: "Why can't you link to Ko-fi, Ampwall, or Buy Me A Coffee profiles for the artists I search for?",
    content: `Basically, it's a technical limitation. These platforms hide their searches from external sources, meaning we can't link directly to an artist profile on these sites in an automated way.  The best alternative is to search those platforms manually, which Unstream offers in the results.`
  },
  {
    title: "How does Hoopla and Freegal work? How does this support the artist?",
    content: `Hoopla and Freegal are services offered through public libraries in the US. To access music through them, you'll most often need a library card from your local library to create an account. Once you do, you'll be able to _rent_ music on demand. More on Hoopla's and Freegal's limits [here](https://www.hoopladigital.com/faq) and [here](https://www.freegalmusic.com/faq).

**Do artists get paid when their music is listened to via one of these services? Unclear, and likely not.** However: you now have access to a vast back catalog of music without your money going to a giant tech conglomerate, and you've found one more way to support your local library.`
  },
  {
    title: "I have an official website but it's not appearing in the results. Why?",
    content: `Unstream uses the [Musicbrainz](https://musicbrainz.org) database as a source to find an artist's official website. If yours isn't appearing, consider creating a Musicbrainz account, looking up your artist name, and filling out your details (it's free and easy!).`
  },
  {
    title: "I have a Faircamp site but it's not appearing in the results. Why?",
    content: `Unstream uses the [Faircamp Webring](http://faircamp.webr.ing) as a source for finding Faircamp sites for independent artists. If your Faircamp site isn't appearing in the results, consider joining the webring [at this link](https://faircamp.webr.ing/#instructions). Or, you can [email me](mailto:support@unstream.stream) your Faircamp URL and I'll have it added to the results.`
  },
  {
    title: "What data does Unstream track? Are my searches anonymous?",
    content: `**Your searches are not linked to you.** There's no search history attached to your account, because we never build one — signing in doesn't change that. We do keep the search terms themselves for a short while, cached so the next person looking for the same artist doesn't cost a dozen platforms another round of requests, but there's nothing stored alongside them that says who searched. Search terms are deliberately kept out of our analytics and our server logs.

**Without an account, nothing identifies you.** We count visits and page views through [GoatCounter](https://www.goatcounter.com), which is cookie-free and doesn't track you between sites, and we count things like "a search returned no results" so we can tell what's broken. The stats artists see on their dashboard are pure daily totals — how many searches an artist appeared in, how many clicks each platform link got — with no user, no session, and no IP attached to them.

**With an account, we store what the account is for:** your email address, the artists you've saved, and any notes you added, so they can sync between the website, the extension and the apps. A username and a location are optional extras, and both are private until you choose to share your list.

We don't sell any of it, we don't run ads, and there are no third-party trackers on the site. The [privacy policy](/privacy-policy) is the long version, and it's specific rather than vague — it names every place data goes and how long each thing is kept. You can ask for a copy of everything we hold on you, or ask us to delete it, by [emailing support](mailto:support@unstream.stream).`
  },
  {
    title: "I am ethically opposed to AI in music. Is AI at all used in Unstream?",
    content: `No AI features are implemented in the Unstream app. The app neither uses AI models to recommend artists nor is intended to promote artists creating AI-generated music.\n\nUnstream shows policy badges for platforms that have formal written policies about AI-generated music (like Bandcamp, Subvert, and Mirlo). These informational badges make it easy to see which platforms are taking a stand to protect human artistry.\n\nParts of Unstream were built and maintained with the help of AI coding tools like Claude Code and OpenCode.`
  },
  {
    title: "Is there a Windows app / iOS app / Android app / Chrome extension / Firefox extension for Unstream?",
    content: `Yes! Unstream is available for [macOS](https://github.com/brandonlucasgreen/unstream/releases/latest), [Chrome](https://chromewebstore.google.com/detail/unstream/ekgpnodajpmdfcbdnbmgcichhbaipnmc), [Firefox](https://addons.mozilla.org/en-US/firefox/addon/unstream/), and [the web](https://unstream.stream).`
  },
  {
    title: "I'd like to request a feature or improvement. How can I do that?",
    content: `Feel free to [open an issue](https://github.com/brandonlucasgreen/unstream/issues) on GitHub to suggest something new or [email me](mailto:support@unstream.stream).`
  },
  {
    title: "I'm having an issue using Unstream. How can I report it?",
    content: `If it's urgent, just [let me know via email](mailto:support@unstream.stream) and I'll try and fix it asap.`
  },
  {
    title: "I love using Unstream, how can I best support the app?",
    content: `Unstream is totally free to use, but please consider supporting it by [buying me a coffee](https://www.buymeacoffee.com/brandonlucasgreen)!`
  }
];
