# Plex Library for IINA

Browse your Plex movies and TV shows, then play them in IINA. Resume where you
left off, choose audio and subtitles, and keep your watching progress synced
with Plex.

## Requirements

- IINA 1.5.1 or newer, with plugins enabled.
- A Plex account with access to a Plex Media Server.
- A connection to that server, either locally or through Plex remote access.

The plugin streams original media files. Your connection needs enough bandwidth
for the selected version; server-side transcoding is not supported.

## Installation

In IINA's plugin manager, install the plugin from this GitHub repository:

```text
gilliginsisland/iina-plex
```

Alternatively, download the `.iinaplgz` file from the
[latest release](https://github.com/gilliginsisland/iina-plex/releases/latest)
and open it with IINA. Accept the installation prompt and enable the plugin.

## Connect to Plex

1. Open **Plugins → Plex Library → Browse Plex Library…**. The menu location
   can vary depending on whether a player window is open.
2. Select **Sign in with Plex**. Complete authorization in your browser, then
   return to IINA.
3. Choose a server. Servers owned by you and servers shared with you are listed
   according to your Plex account's access.

Your login is saved in macOS Keychain so you can reconnect after restarting IINA.
If macOS asks for Keychain access, allow it to keep the login available.

For Plex Home accounts, use **Switch profile** to choose a user. Protected
profiles require their PIN when switching. The last selected profile is restored
after restarting IINA using its saved Keychain authorization; its PIN is never
saved. If that authorization expires or is revoked, select the profile again.

## Browse and play

Open **Home** for **Continue Watching**, **Up Next**, and **Recently Added**, in
that order on one scrollable page. Each section has its own grid and a **Show
more** button when additional titles are available. You can also select a movie
or TV library, then open a show and season to browse its episodes.

- Click a **poster** to play or resume a movie or episode. The library window
  hides when playback starts; reopen it from **Browse Plex Library…** to keep browsing.
- Click its **title** to see details and playback choices.
- Choose **Resume** to continue from the saved position, or **Play from beginning**
  to start over.
- Search the current library or select **All libraries** to search the selected
  server. Use the watched, genre, year, and sort controls to narrow the results.
- Open **Collections** or **Playlists** to browse existing Plex collections and
  video playlists.

The IINA player shows the Plex movie title or the show, season/episode number,
and episode title. Videos split into multiple files also show the part number.

IINA requires the plugin's **file-system** permission to set a custom media title
through mpv. Approve that permission when prompted during installation or update.

The details panel lets you choose a media version, audio track, and subtitles.
You can also change tracks through IINA's normal playback menus.

Where Plex provides intro or credits markers, skip controls become available
while that section is playing.

## Audio and subtitles

Open **Preferences & connection** to set preferred audio and subtitle languages.
Use language codes such as `en`, `eng`, or `es`; leave a field empty to use the
default selection. Subtitle mode can use your preferences, select forced
subtitles only, or turn subtitles off.

A track chosen in a video's details panel overrides these defaults for that
playback. Available tracks can differ between media versions.

Embedded subtitles and supported external subtitles from Plex are available.
External formats include SRT, ASS, SSA, WebVTT, PGS/SUP, and paired VobSub IDX/SUB,
when the server makes them downloadable. External subtitle files are limited
to 16 MiB each.

## Play queues

Choose **Add to queue** or **Play next** in a video's details panel. Queue
entries can be reordered, removed, or played directly. Use **Play show** or
**Play season** to start an ordered episode queue.

In **Preferences & connection**, enable automatic next playback for a cancelable
five-second countdown after an episode finishes. Specials can be included when
playing a whole show. Stopping playback manually does not start the next item.

Queues last for the current session and are cleared when you sign out or switch
profiles.

## Progress and watched status

Playback started through the plugin reports progress to Plex, including pauses,
seeks, stops, and player close. Videos resume from their saved position, including
videos split across multiple files. Other files opened independently in IINA
are not tracked.

If progress cannot be synced, playback continues and the library shows a notice.
The plugin keeps pending progress locally and tries to recover it on reconnect
or when reopening the video, checking for changes made by other Plex clients.
Recent progress can still be lost if IINA is force-quit or the server remains
unavailable.

Use **Mark watched** or **Mark unwatched** in the details panel to change an
item's status. Stop that item first if it is currently playing. Plex determines
when playback counts as completed.

## Updates

Use IINA's plugin manager to check for and install updates. You can also download
and open the package from the
[latest release](https://github.com/gilliginsisland/iina-plex/releases/latest).

If you installed a version older than 0.7.2, install a current package manually
once to enable GitHub update checks.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| The plugin menu is missing | Enable plugins in IINA's settings and make sure Plex Library is enabled. |
| Your server is missing | Choose **Refresh servers** under **Preferences & connection**. Check that the server is online and your Plex account or Home profile has access. |
| The library or artwork is out of date | Use **Refresh** in the library toolbar. |
| A request fails or the server address changed | Choose **Reconnect** under **Preferences & connection**, then reopen the video if necessary. |
| A local server only offers HTTP | Enable **Allow unencrypted local connections**, then reconnect. Use this only on a network you trust. |
| Resume cannot reach the saved position | Reopen the video. Playback pauses if the position cannot be reached, preserving the saved position. You can also choose **Play from beginning**. |
| An audio or subtitle track is missing | Check the selected media version. Try IINA's track menus or another version of the video. |
| Sign-in is rejected | Sign out and authorize the plugin again through Plex. |

## Limitations

- Movies and TV/video libraries only; music and photos are not supported.
- Original-file streaming only, without transcoding or offline downloads.
- Search covers one selected server at a time.
- Collections and playlists can be browsed and played, but not edited.
- Intro/credits skipping and Home profiles depend on your Plex server and account.
- A running stream may need to be reopened after reconnecting.

## Account access

Authorization happens through Plex in your browser. Your Plex password is not
entered into the plugin. The saved account token and the last selected profile's
authorization use macOS Keychain; profile PINs are never saved.

Use **Sign out** to clear the saved login and pending progress. Already opened
players can continue playback. To revoke access completely, remove
**IINA Plex Library** from your Plex account's authorized devices.

## Stored settings

IINA saves the selected profile ID, server/library choices, playback preferences,
and pending progress in this file:

```text
~/Library/Application Support/com.colliderli.iina/plugins/.preferences/io.iina.plex-library.plist
```

This is an ordinary preferences file, not an encrypted credential store. Account
and profile authorization tokens are stored separately in macOS Keychain. In
Keychain Access, look for `io.iina.plex-library - Plex account` and
`io.iina.plex-library - Plex Home profile`. Neither the preferences file nor
Keychain stores your profile PIN.

Plugin updates preserve these settings because they are stored outside the
installed plugin folder. Downloaded artwork and subtitles use temporary files;
artwork caching is in memory.

## Report a problem

[Open an issue](https://github.com/gilliginsisland/iina-plex/issues) with your
IINA version, what you were trying to do, the steps to reproduce it, and any
error message shown in the library. Please remove account tokens and personal
server details from any logs you attach.
