using System;
using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Shared.Models
{
    public class Game
    {
        public Game() { }

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
        public int? Value
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
}
