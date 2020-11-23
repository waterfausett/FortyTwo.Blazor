using System;
using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Shared.Models
{
    // TODO: prolly need a way to denote that a game is in progress or not
    // - might could infer this from players not having dominos? (not sure this would work)
    public class GameContext
    {
        public Guid Id { get; set; }
        public string Name { get; set; }
        public Player BiddingPlayer => Players?.OrderByDescending(x => x.Bid).FirstOrDefault();
        public int? Trump { get; set; }
        public Trick CurrentTrick { get; set; } = new Trick();
        public List<Trick> Tricks { get; set; } = new List<Trick>();
        public Player CurrentPlayer => Players?.FirstOrDefault(x => x.IsActive);
        public List<Player> Players { get; set; } = new List<Player>();
    }
}
