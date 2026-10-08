CREATE TABLE `test_orders` (
	`account_id` integer NOT NULL,
	`batch_date` text NOT NULL,
	`ad_ids` text NOT NULL,
	`n_ads` integer NOT NULL,
	`suggested` text NOT NULL,
	`parts` text NOT NULL,
	`detail` text NOT NULL,
	`reason` text NOT NULL,
	`variable` text,
	`confirmed_at` integer,
	`found_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `batch_date`),
	FOREIGN KEY (`account_id`) REFERENCES `ad_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `ads` ADD `angle_key` text;