import { Platform } from 'react-native';
import TrackPlayer, {
  Event,
  PlaybackState,
  PlayerCommand,
} from '@rntp/player';
import { appError, toAppError } from '../core/errors';
import { ResolvedStream, Track } from '../core/types';

export type PlaybackStatus = {
  isPlaying: boolean;
  isBuffering: boolean;
  isLoaded: boolean;
  /** Seconds. */
  position: number;
  /** Seconds; 0 until the source reports one. */
  duration: number;
  volume: number;
};

export const IDLE_STATUS: PlaybackStatus = {
  isPlaying: false,
  isBuffering: false,
  isLoaded: false,
  position: 0,
  duration: 0,
  volume: 1,
};

type EngineEvents = {
  onStatus: (status: PlaybackStatus) => void;
  /** The current track played through to its end. */
  onComplete: () => void;
  /** Playback failed for the loaded track. */
  onError: (error: unknown) => void;
  /**
   * The OS-level skip-next / skip-previous control was pressed (lock
   * screen, notification, Bluetooth/AVRCP, Android Auto). Configured below
   * (see setCommands) with handling: 'hybrid' and Next/Previous specifically
   * routed to JS — everything else (play/pause/seek) stays on RNTP's
   * reliable default native handling. This is a deliberate choice: our
   * queue still lives outside RNTP (one track loaded at a time, same as
   * before), so "next" has to mean "ask the app to load a different
   * track," not "advance RNTP's own queue" — native handling alone
   * couldn't do that.
   */
  onRemoteNext: () => void;
  onRemotePrevious: () => void;
};

/**
 * Wraps react-native-track-player v5 (@rntp/player) behind the SAME small
 * imperative interface PlaybackEngine has always exposed to the rest of the
 * app — usePlayer.tsx does not need to change for this migration.
 *
 * Still loads ONE track at a time via load(), same as before — this
 * migration does not turn the app into a real multi-track native queue.
 * What v5 fixes on its own, with no further work: the progress bar and
 * play/pause/seek all rendering correctly, because RNTP owns a real,
 * standard notification instead of expo-audio's hand-rolled one. Real
 * native next/prev (skipping within an actual queued set of tracks) is a
 * separate, later step if you ever want it.
 */
export class PlaybackEngine {
  private listeners: Partial<EngineEvents> = {};

  private status: PlaybackStatus = { ...IDLE_STATUS };
  private currentTrackId: string | null = null;
  private desiredVolume = 1;

  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private loadToken = 0;
  private completionFired = false;

  private configured = false;

  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private eventSubs: { remove: () => void }[] = [];

  on<K extends keyof EngineEvents>(event: K, handler: EngineEvents[K]): void {
    this.listeners[event] = handler;
  }

  getStatus(): PlaybackStatus {
    return this.status;
  }

  /** Set up the player once. Safe to call repeatedly. Fully synchronous. */
  configure(): void {
    if (this.configured) return;

    TrackPlayer.setupPlayer({
      contentType: 'music',
      handleAudioBecomingNoisy: true,
    });

    // handling: 'hybrid' keeps Play/Pause/Seek on RNTP's reliable native
    // path (works with Android Auto, Bluetooth, etc. with zero JS), while
    // routing Next/Previous to our own onRemoteNext/onRemotePrevious —
    // required because our queue is still external to RNTP (see class doc).
    TrackPlayer.setCommands({
      capabilities: [
        PlayerCommand.PlayPause,
        PlayerCommand.Next,
        PlayerCommand.Previous,
        PlayerCommand.Seek,
      ],
      handling: 'hybrid',
      perCommandHandling: {
        [PlayerCommand.Next]: 'js',
        [PlayerCommand.Previous]: 'js',
      },
    });

    this.attachEventListeners();
    this.startProgressPolling();
    this.configured = true;
  }

  private attachEventListeners(): void {
    this.eventSubs.push(
      TrackPlayer.addEventListener(Event.PlaybackStateChanged, ({ state }) => {
        this.handlePlaybackStateChanged(state);
      })
    );

    this.eventSubs.push(
      TrackPlayer.addEventListener(Event.IsPlayingChanged, ({ playing }) => {
        this.status = { ...this.status, isPlaying: playing };
        this.listeners.onStatus?.(this.status);
      })
    );

    this.eventSubs.push(
      TrackPlayer.addEventListener(Event.PlaybackError, ({ message }) => {
        this.clearLoadTimer();
        this.listeners.onError?.(appError('playback_failed', message));
      })
    );

    this.eventSubs.push(
      TrackPlayer.addEventListener(Event.RemoteNext, () => {
        this.listeners.onRemoteNext?.();
      })
    );

    this.eventSubs.push(
      TrackPlayer.addEventListener(Event.RemotePrevious, () => {
        this.listeners.onRemotePrevious?.();
      })
    );
  }

  /** No per-tick position event in this API — poll on the old 250ms cadence. */
  private startProgressPolling(): void {
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => {
      try {
        const progress = TrackPlayer.getProgress();
        const duration = Number.isFinite(progress.duration) && progress.duration > 0
          ? progress.duration
          : 0;
        const position = Number.isFinite(progress.position)
          ? Math.max(0, progress.position)
          : 0;

        if (duration > 0 && this.loadTimer) {
          this.clearLoadTimer();
        }

        this.status = { ...this.status, position, duration };
        this.listeners.onStatus?.(this.status);
      } catch {
        /* transient — the queue may be momentarily empty */
      }
    }, 250);
  }

  private handlePlaybackStateChanged(state: PlaybackState): void {
    // PATCH: the correct "track finished" signal for a single-item queue is
    // PlaybackState.Ended — the previous version watched for
    // MediaItemTransition firing with a null item instead, which only
    // happens when a NEXT queued item is removed/skipped past, not when a
    // lone track simply plays to the end. That's why playback was stopping
    // silently instead of advancing: onComplete was never being called.
    if (state === PlaybackState.Ended && !this.completionFired) {
      this.completionFired = true;
      this.listeners.onComplete?.();
    }

    // PlaybackState here is Idle | Ready | Buffering | Ended | Error —
    // "is it playing" is tracked separately via IsPlayingChanged above.
    const isBuffering = state === PlaybackState.Buffering;
    const isLoaded = state === PlaybackState.Ready || state === PlaybackState.Buffering;

    this.status = {
      ...this.status,
      isBuffering,
      isLoaded,
      volume: this.desiredVolume,
    };
    this.listeners.onStatus?.(this.status);
  }

  private clearLoadTimer(): void {
    if (this.loadTimer) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
  }

  /** Load a resolved stream and begin playing it. */
  async load(
    track: Track,
    stream: ResolvedStream,
    options: { autoPlay?: boolean; startPosition?: number } = {}
  ): Promise<void> {
    const { autoPlay = true, startPosition = 0 } = options;
    const token = ++this.loadToken;

    try {
      this.configure();

      this.currentTrackId = track.id;
      this.completionFired = false;

      this.status = { ...IDLE_STATUS, isBuffering: true, volume: this.desiredVolume };
      this.listeners.onStatus?.(this.status);

      // setMediaItems() replaces the whole queue with this one track,
      // matching the old engine's "one track at a time" contract exactly.
      // headers live nested under `url`, not as a sibling field — confirmed
      // against the real MediaItem type, not the library's own docs (which
      // didn't show this at all).
      TrackPlayer.setMediaItems([
        {
          mediaId: track.id,
          url: { uri: stream.url, headers: stream.headers },
          title: track.title,
          artist: track.artist.name,
          albumTitle: track.album,
          artworkUrl: track.albumImageUrl || undefined,
        },
      ]);
      TrackPlayer.setVolume(this.desiredVolume);

      // If the source never loads, surface a real error instead of hanging.
      this.clearLoadTimer();
      this.loadTimer = setTimeout(() => {
        if (token !== this.loadToken) return;
        if (this.status.isLoaded) return;
        this.listeners.onError?.(appError('playback_failed', 'Stream did not start'));
      }, 20_000);

      if (startPosition > 0) {
        try {
          TrackPlayer.seekTo(startPosition);
        } catch {
          // Seeking before the source is ready is not fatal.
        }
      }

      if (autoPlay) {
        TrackPlayer.play();
      }
    } catch (e) {
      this.clearLoadTimer();
      throw toAppError(e, 'playback_failed');
    }
  }

  play(): void {
    try {
      TrackPlayer.play();
    } catch (e) {
      this.listeners.onError?.(toAppError(e, 'playback_failed'));
    }
  }

  pause(): void {
    try {
      TrackPlayer.pause();
    } catch {
      /* pausing a released player is harmless */
    }
  }

  async seekTo(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds)) return;

    const duration = this.status.duration;
    const target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);

    try {
      this.completionFired = false;
      TrackPlayer.seekTo(target);

      this.status = { ...this.status, position: target };
      this.listeners.onStatus?.(this.status);
    } catch (e) {
      this.listeners.onError?.(toAppError(e, 'playback_failed'));
    }
  }

  setVolume(volume: number): void {
    this.desiredVolume = Math.max(0, Math.min(1, volume));
    if (this.configured) {
      try {
        TrackPlayer.setVolume(this.desiredVolume);
      } catch {
        /* best effort */
      }
    }

    this.status = { ...this.status, volume: this.desiredVolume };
    this.listeners.onStatus?.(this.status);
  }

  getVolume(): number {
    return this.desiredVolume;
  }

  /** Stop and unload, returning the engine to idle. */
  stop(): void {
    this.clearLoadTimer();
    this.loadToken++;
    this.currentTrackId = null;
    this.completionFired = false;

    try {
      TrackPlayer.stop();
    } catch {
      /* already torn down */
    }

    this.status = { ...IDLE_STATUS, volume: this.desiredVolume };
    this.listeners.onStatus?.(this.status);
  }

  get trackId(): string | null {
    return this.currentTrackId;
  }

  async release(): Promise<void> {
    if (Platform.OS === 'web') return;

    this.clearLoadTimer();

    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }

    for (const sub of this.eventSubs) {
      sub.remove();
    }
    this.eventSubs = [];

    this.configured = false;

    try {
      TrackPlayer.stop();
    } catch {
      /* best effort */
    }
  }
}

export const playbackEngine = new PlaybackEngine();
