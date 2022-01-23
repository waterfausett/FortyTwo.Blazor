namespace FortyTwo.Shared.Models
{
    public enum Suit
    {
        Low = -2,
        None = -1,
        Blanks = 0,
        Aces = 1,
        Deuces = 2,
        Threes = 3,
        Fours = 4,
        Fives = 5,
        Sixes = 6,
    }

    public static class SuitExtensions
    {
        public static string ToPrettyString(this Suit suit)
            => suit switch
            {
                Suit.None => "Follow Me",
                _ => suit.ToString()
            };
    }
}
