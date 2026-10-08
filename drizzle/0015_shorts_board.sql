CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`srt_path` text NOT NULL,
	`folder` text NOT NULL,
	`stem` text NOT NULL,
	`num` integer NOT NULL,
	`title` text NOT NULL,
	`master_asset_id` integer,
	`srt_size` integer,
	`srt_mtime` integer,
	`cues` text,
	`cue_count` integer DEFAULT 0 NOT NULL,
	`duration_s` real,
	`read_error` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`gone_at` integer,
	FOREIGN KEY (`master_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_srt_path_unique` ON `episodes` (`srt_path`);--> statement-breakpoint
CREATE INDEX `episodes_num_idx` ON `episodes` (`num`);--> statement-breakpoint
CREATE INDEX `episodes_master_idx` ON `episodes` (`master_asset_id`);--> statement-breakpoint
CREATE TABLE `shorts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`episode_id` integer,
	`k` integer,
	`start_s` real NOT NULL,
	`end_s` real NOT NULL,
	`first_line` text NOT NULL,
	`hook_words` text NOT NULL,
	`why` text,
	`layout` text NOT NULL,
	`status` text DEFAULT 'idea' NOT NULL,
	`kept` integer,
	`archived_at` integer,
	`hook_id` integer,
	`hook_owned` integer DEFAULT false NOT NULL,
	`job_id` integer,
	`output_asset_id` integer,
	`yt_video_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hook_id`) REFERENCES `hooks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`output_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shorts_episode_k_uniq` ON `shorts` (`episode_id`,`k`) WHERE episode_id is not null;--> statement-breakpoint
CREATE INDEX `shorts_status_idx` ON `shorts` (`status`);--> statement-breakpoint
CREATE INDEX `shorts_hook_idx` ON `shorts` (`hook_id`);