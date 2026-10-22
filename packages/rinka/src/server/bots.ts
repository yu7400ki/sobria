/** 検索エンジンのクローラーと、リンクのプレビューを作成するサービスの User-Agent に一致する正規表現。 */
const bots =
  /googlebot|google-inspectiontool|bingbot|slurp|duckduckbot|baiduspider|yandex(bot|images)|applebot|petalbot|facebookexternalhit|facebookcatalog|meta-externalagent|twitterbot|slackbot|discordbot|linkedinbot|telegrambot|whatsapp|pinterestbot|redditbot|embedly|skypeuripreview|line\/|kakaotalk-scrap|mastodon|bluesky|iframely/i;

/** `userAgent` が、JS を実行しないことがある bot かどうかを返す。 */
export const isBot = (userAgent: string | null | undefined): boolean =>
  userAgent !== null && userAgent !== undefined && bots.test(userAgent);
