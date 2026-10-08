CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `asset_clients` (
	`asset_id` integer NOT NULL,
	`client_id` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `client_id`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_clients_client_idx` ON `asset_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`section_id` integer NOT NULL,
	`root_id` integer NOT NULL,
	`path` text NOT NULL,
	`rel_path` text NOT NULL,
	`filename` text NOT NULL,
	`ext` text NOT NULL,
	`sha256` text,
	`kind` text NOT NULL,
	`bytes` integer NOT NULL,
	`duration_s` real,
	`width` integer,
	`height` integer,
	`orientation` text,
	`fps` real,
	`codec` text,
	`created_at` integer,
	`mtime` integer NOT NULL,
	`indexed_at` integer NOT NULL,
	`missing` integer DEFAULT false NOT NULL,
	`thumb_path` text,
	`sheet_path` text,
	`proxy_path` text,
	`derive_status` text DEFAULT 'pending' NOT NULL,
	`derive_error` text,
	`description` text,
	`description_model` text,
	`asset_class` text,
	`class_confidence` real,
	`tags` text,
	`needs_review` integer,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_id`) REFERENCES `roots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_path_unique` ON `assets` (`path`);--> statement-breakpoint
CREATE INDEX `assets_section_idx` ON `assets` (`section_id`,`missing`);--> statement-breakpoint
CREATE INDEX `assets_root_idx` ON `assets` (`root_id`);--> statement-breakpoint
CREATE INDEX `assets_sha_idx` ON `assets` (`sha256`);--> statement-breakpoint
CREATE INDEX `assets_mtime_idx` ON `assets` (`mtime`);--> statement-breakpoint
CREATE INDEX `assets_kind_idx` ON `assets` (`kind`);--> statement-breakpoint
CREATE TABLE `clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`section_id` integer NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`meta_ad_account_id` text,
	`brand_notes` text,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_code_unique` ON `clients` (`code`);--> statement-breakpoint
CREATE TABLE `ignore_patterns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ignore_patterns_pattern_unique` ON `ignore_patterns` (`pattern`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`asset_id` integer,
	`input` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`log_path` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_queue_idx` ON `jobs` (`status`,`priority`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_asset_idx` ON `jobs` (`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_active_uniq` ON `jobs` (`type`,`asset_id`) WHERE status in ('pending','running');--> statement-breakpoint
CREATE TABLE `roots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`section_id` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roots_path_unique` ON `roots` (`path`);--> statement-breakpoint
CREATE TABLE `sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sections_key_unique` ON `sections` (`key`);--> statement-breakpoint
CREATE TABLE `tag_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path_glob` text NOT NULL,
	`client_codes` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_status` (
	`id` integer PRIMARY KEY NOT NULL,
	`pid` integer,
	`started_at` integer,
	`last_seen` integer,
	`drive_mounted` integer,
	`queue_pending` integer,
	`queue_running` integer,
	`queue_error` integer,
	`current_file` text,
	`scan_state` text,
	`scan_seen` integer,
	`cache_bytes` integer,
	`cache_bytes_at` integer,
	`message` text
);
