CREATE TABLE `yt_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`status` integer,
	`ms` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `yt_calls_at_idx` ON `yt_calls` (`at`);--> statement-breakpoint
CREATE TABLE `yt_channels` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`uploads_playlist` text,
	`published_at` integer,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `yt_metrics` (
	`video_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`views` integer,
	`avg_view_pct` real,
	`avg_view_s` real,
	`likes` integer,
	`subs_gained` integer,
	`engaged_views` integer,
	`shares` integer,
	`comments` integer,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`video_id`, `snapshot_date`)
);
--> statement-breakpoint
CREATE TABLE `yt_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`verifier` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `yt_videos` (
	`video_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`published_at` integer,
	`duration_s` real,
	`is_short` integer DEFAULT false NOT NULL,
	`privacy` text,
	`thumb_url` text,
	`thumb_path` text,
	`thumb_error` text,
	`matched_asset_id` integer,
	`match_source` text,
	`match_detail` text,
	`gone_at` integer,
	`first_seen_at` integer NOT NULL,
	`last_synced_at` integer NOT NULL,
	FOREIGN KEY (`matched_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `yt_videos_asset_idx` ON `yt_videos` (`matched_asset_id`);--> statement-breakpoint
CREATE INDEX `yt_videos_short_idx` ON `yt_videos` (`is_short`,`published_at`);--> statement-breakpoint
ALTER TABLE `worker_status` ADD `yt_state` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `yt_current` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `yt_note` text;