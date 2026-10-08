CREATE TABLE `ad_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`studio_order_id` text NOT NULL,
	`file_path` text NOT NULL,
	`section_id` integer NOT NULL,
	`client_id` integer,
	`channel_code` text NOT NULL,
	`act_id` text NOT NULL,
	`media_asset_id` integer,
	`media_kind` text NOT NULL,
	`hook_ids` text NOT NULL,
	`source_from` text NOT NULL,
	`source_ref` text,
	`name_preview` text NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`ad_id` text,
	`ad_name` text,
	`applied_at` text,
	`error` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`cancelled_at` integer,
	`status_read_at` integer,
	`read_error` text,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ad_orders_studio_order_id_unique` ON `ad_orders` (`studio_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ad_orders_file_path_unique` ON `ad_orders` (`file_path`);--> statement-breakpoint
CREATE INDEX `ad_orders_status_idx` ON `ad_orders` (`status`);--> statement-breakpoint
CREATE INDEX `ad_orders_client_idx` ON `ad_orders` (`channel_code`,`created_at`);