namespace FortyTwo.Shared.Models
{
    public enum Bid
    {
        Pass = 0,
        Thirty = 30,
        ThirtyOne = 31,
        ThirtyTwo = 32,
        ThrityThree = 33,
        ThirtyFour = 34,
        ThrityFive = 35,
        ThritySix = 36,
        ThritySeven = 37,
        ThrityEight = 38,
        ThirtyNine = 39,
        Fourty = 40,
        FourtyOne = 41,
        FourtyTwo = 42,
        EightyFour = 84,
        ThreeMarks = 126,
        FourMarks = 168,
        Plunge = 169,
        FiveMarks = 210,
        SixMarks = 252,
        SevenMarks = 294
    }

    public static class BidExtensions
    {
        public static string ToPrettyString(this Bid bid)
            => bid switch
            {
                Bid.Pass => bid.ToString(),
                Bid.Plunge => bid.ToString(),
                Bid.ThreeMarks => "3 Marks",
                Bid.FourMarks => "4 Marks",
                Bid.FiveMarks => "5 Marks",
                Bid.SixMarks => "6 Marks",
                Bid.SevenMarks => "7 Marks",
                _ => ((int)bid).ToString()
            };

        public static string ToPrettyString(this Bid? bid)
            => bid == null || !bid.HasValue
                ? "N/A"
                : bid.Value.ToPrettyString();
    }
}
