﻿using System;
using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Shared.Models
{
    public enum Positions
    {
        First = 0,
        Second = 1,
        Third = 2,
        Fourth = 3,
    }

    public static class PositionsExtensions
    {
        public static Positions NextPosition(this Positions position)
        {
            return (Positions)(((int)position + 1) % 4);
        }
    }

    public enum Teams
    {
        TeamA = 1,
        TeamB = 2,
    }

    public class Match
    {
        private const int WinningScore = 7;

        public Match()
        {
            Id = Guid.NewGuid();
            CreatedOn = UpdatedOn = DateTimeOffset.UtcNow;
            Teams = new Dictionary<Teams, List<Player>>()
            {
                { Models.Teams.TeamA, new List<Player>() },
                { Models.Teams.TeamB, new List<Player>() },
            };
        }

        public Guid Id { get; set; } // TODO: in practice, this prolly shouldn't have a public setter
        public Game CurrentGame { get; set; } = new Game("Game 1");
        public Dictionary<Teams, List<Player>> Teams { get; set; }
        public IReadOnlyList<Player> Players => Teams.SelectMany(x => x.Value).ToList();
        public Dictionary<Teams, List<Game>> Games { get; set; } = new Dictionary<Teams, List<Game>>();
        public Dictionary<Teams, int> Scores => Games?.ToDictionary(kv => kv.Key, kv => kv.Value.Sum(g => g.Value ?? 0));
        public Teams? WinningTeam
        {
            get => Scores.Values.Any(x => x >= WinningScore)
                ? Scores.First(x => x.Value >= WinningScore).Key
                : null;
        }
        public DateTimeOffset CreatedOn { get; set; }
        public DateTimeOffset UpdatedOn { get; set; }

        public void SelectNextPlayer()
        {
            // TODO: should no-op or blow up here?

            if (string.IsNullOrWhiteSpace(CurrentGame?.CurrentPlayerId)) return;

            var nextPlayerPosition = Players.First(x => x.Id == CurrentGame.CurrentPlayerId).Position.NextPosition();

            CurrentGame.CurrentPlayerId = Players.First(x => x.Position == nextPlayerPosition).Id;
        }

        // TODO: validate
    }

    public class Game
    {
        public Game(string name)
        {
            Name = name;
            Id = Guid.NewGuid();
        }

        public Guid Id { get; set; } // TODO: in practice, this prolly shouldn't have a public setter
        public string Name { get; set; }
        public string FirstActionBy { get; set; }
        public Bid? Bid { get; set; }
        public string BiddingPlayerId { get; set; }
        public Suit? Trump { get; set; }
        public string CurrentPlayerId { get; set; }

        // TODO: consider changing this to be a dictionary
        public List<Hand> Hands { get; set; } = new List<Hand>(); // this shouldn't be fully exposed
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
        public Teams? WinningTeam {
            get 
            {
                if (BiddingPlayerId == null) return null;

                var biddingTeamId = Hands?.FirstOrDefault(x => x.PlayerId == BiddingPlayerId)?.Team;
                var otherTeamId = Hands?.FirstOrDefault(x => x.Team != biddingTeamId)?.Team;
                var teamPoints = Tricks.GroupBy(t => t.Team).ToDictionary(g => g.Key, g => g.Sum(t => t.Value));

                var adjustedBid = (int)Bid % 42 == 0 ? 42 : (int)Bid;
                return teamPoints.TryGetValue(biddingTeamId, out var biddingTeamPoints) && biddingTeamPoints >= adjustedBid
                    ? biddingTeamId
                    : teamPoints.TryGetValue(otherTeamId, out var otherTeamPoints) && otherTeamPoints > (42 - adjustedBid)
                        ? otherTeamId
                        : null;
            }
        }
    }

    public class Hand
    {
        public string PlayerId { get; set; }
        public Teams Team { get; set; }
        public List<Domino> Dominos { get; set; } = new List<Domino>();
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
