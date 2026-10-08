CREATE TABLE `ad_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`section_id` integer NOT NULL,
	`client_id` integer,
	`act_id` text NOT NULL,
	`identity` text NOT NULL,
	`timezone` text,
	`campaign_source` text,
	`last_sync_at` integer,
	`last_attempt_at` integer,
	`error` text,
	`leads_source` text,
	`ghl_synced_at` integer,
	`ghl_error` text,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_accounts_act_id_unique` ON `ad_accounts` (`act_id`);--> statement-breakpoint
CREATE TABLE `ad_metrics` (
	`meta_ad_id` text NOT NULL,
	`date` text NOT NULL,
	`account_id` integer NOT NULL,
	`ad_name` text,
	`spend` real DEFAULT 0 NOT NULL,
	`impressions` integer DEFAULT 0 NOT NULL,
	`reach` integer,
	`frequency` real,
	`clicks` integer DEFAULT 0 NOT NULL,
	`ctr` real,
	`cpm` real,
	`link_clicks` integer DEFAULT 0 NOT NULL,
	`cost_per_link_click` real,
	`meta_leads` integer DEFAULT 0 NOT NULL,
	`video_3s` integer DEFAULT 0 NOT NULL,
	`thruplays` integer DEFAULT 0 NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`meta_ad_id`, `date`),
	FOREIGN KEY (`account_id`) REFERENCES `ad_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ad_metrics_account_idx` ON `ad_metrics` (`account_id`,`date`);--> statement-breakpoint
CREATE TABLE `ad_windows` (
	`meta_ad_id` text NOT NULL,
	`window` text NOT NULL,
	`reach` integer,
	`impressions` integer,
	`frequency` real,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`meta_ad_id`, `window`)
);
--> statement-breakpoint
CREATE TABLE `ads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meta_ad_id` text NOT NULL,
	`account_id` integer NOT NULL,
	`campaign_id` text,
	`campaign_name` text,
	`adset_id` text,
	`adset_name` text,
	`name` text NOT NULL,
	`effective_status` text,
	`configured_status` text,
	`created_time` integer,
	`first_spend_date` text,
	`last_spend_date` text,
	`creative` text,
	`media_name` text,
	`media_name_at` integer,
	`thumb_path` text,
	`thumb_error` text,
	`matched_asset_id` integer,
	`match_source` text,
	`match_detail` text,
	`first_seen_at` integer NOT NULL,
	`last_synced_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `ad_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matched_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ads_meta_ad_id_unique` ON `ads` (`meta_ad_id`);--> statement-breakpoint
CREATE INDEX `ads_account_idx` ON `ads` (`account_id`);--> statement-breakpoint
CREATE INDEX `ads_asset_idx` ON `ads` (`matched_asset_id`);--> statement-breakpoint
CREATE TABLE `channel_metrics` (
	`account_id` integer NOT NULL,
	`window` text NOT NULL,
	`date_start` text,
	`date_stop` text,
	`spend` real,
	`impressions` integer,
	`reach` integer,
	`clicks` integer,
	`ctr` real,
	`cpm` real,
	`link_clicks` integer,
	`cost_per_link_click` real,
	`meta_leads` integer,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `window`),
	FOREIGN KEY (`account_id`) REFERENCES `ad_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ghl_leads` (
	`contact_id` text PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`date_added` integer,
	`first_utm_content` text,
	`first_medium_id` text,
	`last_utm_content` text,
	`last_medium_id` text,
	`test` integer DEFAULT false NOT NULL,
	`ad_id` text,
	`attributed_via` text,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `ad_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ghl_leads_account_idx` ON `ghl_leads` (`account_id`,`date_added`);--> statement-breakpoint
CREATE INDEX `ghl_leads_ad_idx` ON `ghl_leads` (`ad_id`);--> statement-breakpoint
CREATE TABLE `meta_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`identity` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`status` integer,
	`ms` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `meta_calls_at_idx` ON `meta_calls` (`at`);--> statement-breakpoint
CREATE TABLE `meta_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`name` text NOT NULL,
	`effective_status` text,
	`start_date` text,
	`backfilled_at` integer,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `ad_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meta_campaigns_account_idx` ON `meta_campaigns` (`account_id`);--> statement-breakpoint
ALTER TABLE `worker_status` ADD `meta_state` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `meta_current` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `meta_note` text;