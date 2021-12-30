using System;
using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Shared.Models
{
    public class Match
    {
        private const int WinningScore = 7;

        public Match()
        {
            CreatedOn = DateTimeOffset.UtcNow;
            Id = Guid.NewGuid();
        }

        public Guid Id { get; set; }
        public Player[] Players { get; set; } = new Player[4];
        public Game CurrentGame { get; set; } = new Game();
        public Dictionary<int, List<Game>> Games { get; set; } = new Dictionary<int, List<Game>>();
        public Dictionary<int, int> Scores => Games?.ToDictionary(kv => kv.Key, kv => kv.Value.Sum(g => g.Value ?? 0));
        public int? WinningTeamId
        {
            get { 
                var teamId = Scores.FirstOrDefault(x => x.Value >= WinningScore).Key;
                return teamId == 0 ? (int?)null : teamId;
            }
        }
        public DateTimeOffset CreatedOn { get; set; }
        public DateTimeOffset UpdatedOn { get; set; }

        // TODO: validate
    }

    public class Game
    {
        public Guid Id { get; set; }
        public string Name { get; set; }
        public string FirstActionBy { get; set; }
        public Bid? Bid { get; set; }
        public string BiddingPlayerId { get; set; }
        public Suit? Trump { get; set; }
        public string CurrentPlayerId { get; set; }

        // TODO: consider changing this to be a dictionary
        public List<Hand> Hands { get; set; } // this shouldn't be fully exposed
        public Trick CurrentTrick { get; set; } = new Trick();
        public List<Trick> Tricks { get; set; } = new List<Trick>();
        internal int? Value
        {
            get 
            {
                if (BiddingPlayerId == null) return null;

                var bid = Hands?.FirstOrDefault(x => x.PlayerId == BiddingPlayerId)?.Bid;
                return bid == null
                    ? (int?)null
                    : (int)bid <= 42 ? 1 : (int)bid / 42; 
            }
        }
        internal int? WinningTeamId {
            get 
            {
                if (BiddingPlayerId == null) return null;

                var biddingTeamId = Hands?.FirstOrDefault(x => x.PlayerId == BiddingPlayerId)?.TeamId;
                var otherTeamId = Hands?.FirstOrDefault(x => x.TeamId != biddingTeamId)?.TeamId;
                var teamPoints = Tricks.GroupBy(t => t.TeamId).ToDictionary(g => g.Key, g => g.Sum(t => t.Value));

                var adjustedBid = (int)Bid % 42 == 0 ? 42 : (int)Bid;
                return teamPoints[biddingTeamId] >= adjustedBid
                    ? biddingTeamId
                    : teamPoints[otherTeamId] > (42 - adjustedBid)
                        ? otherTeamId
                        : null;
            }
        }

        public void SelectNextPlayer()
        {
            var nextPlayerIndex = Hands.FindIndex(x => x.PlayerId == CurrentPlayerId) + 1;

            CurrentPlayerId = Hands[nextPlayerIndex % Hands.Count].PlayerId;
        }
    }

    public class Hand
    {
        public string PlayerId { get; set; }
        public int TeamId { get; set; }
        public List<Domino> Dominos { get; set; }
        public Bid? Bid { get; set; }
    }

    public enum Suit
    {
        Blanks = 0,
        Aces = 1,
        Deuces = 2,
        Threes = 3,
        Fours = 4,
        Fives = 5,
        Sixes = 6,
    }

    public enum Bid
    {
        Pass = 0,
        Plunge = 1,
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
