using System;
using System.Collections.Generic;

namespace FortyTwo.Shared.Models
{
    // TODO: think about how we're going to track this but be able to send out of API w/o the dominos property for the other players
    //  - interface won't be enough for this
    //  - maybe another DTO where the Dominos property is a int holding how many that player has unless you are that player
    //  -- maybe we'd return "you" in a sep prop?

    public interface IPlayer
    {
        public Guid Id { get; set; }
        public string Name { get; set; }
        public bool IsActive { get; set; }
    }

    public class Player : IPlayer
    {
        public Guid Id { get; set; }
        public string Name { get; set; }
        public bool IsActive { get; set; }
        public List<Domino> Dominos { get; set; } = new List<Domino>();
    }
}
